"""
FlowPOS â€” main.py
Ø¨Ø¹Ø¯ Phase 4: ØªÙ… ØªÙ‚Ø³ÙŠÙ… Ø§Ù„ÙƒÙˆØ¯ Ø¥Ù„Ù‰ routers Ù…Ù†ÙØµÙ„Ø©
"""
import json
import os
import plistlib
import re
import sys
import asyncio
from html import escape
from datetime import datetime
import uuid

from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest
from sqlalchemy import inspect, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from database import AsyncSessionLocal, engine, Base, get_db
from models import Customer, Product, ProductBarcode, Session as CashierSession, SystemSetting
from ws_manager import ConnectionManager
from routers.deps import get_current_user
from services.customer_telegram_service import process_telegram_start_token
from services.license_service import build_activation_request_url, get_public_license_summary, should_block_usage
from services.local_ssl_service import get_lan_ip, get_local_ssl_runtime_status
from services.timezone_service import DEFAULT_TIMEZONE, LOCAL_TIMEZONE, utc_now
import telegram_alerts

from dotenv import load_dotenv


def _load_env_files() -> None:
    candidates = []
    configured = os.getenv("FLOWPOS_ENV_FILE", "").strip()
    if configured:
        candidates.append(configured)
    module_env = os.path.join(os.path.dirname(__file__), ".env")
    candidates.append(module_env)
    meipass = getattr(sys, "_MEIPASS", "")
    if meipass:
        candidates.append(os.path.join(meipass, ".env"))
        candidates.append(os.path.join(meipass, "flowpos-sidecar.env"))
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            load_dotenv(candidate, override=False)


_load_env_files()

_DEFAULT_CORS_ORIGINS = [
    "http://localhost",
    "http://localhost:8000",
    "http://localhost:5173",
    "https://localhost",
    "https://localhost:8000",
    "http://127.0.0.1",
    "http://127.0.0.1:8000",
    "http://127.0.0.1:5173",
    "https://127.0.0.1",
    "https://127.0.0.1:8000",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
]
_DEFAULT_CORS_REGEX = (
    r"^https?://("
    r"(?:tauri\.localhost)|"
    r"(?:10(?:\.\d{1,3}){3})|"
    r"(?:127(?:\.\d{1,3}){3})|"
    r"(?:192\.168(?:\.\d{1,3}){2})|"
    r"(?:172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})"
    r")(?::\d+)?$"
)


def _parse_cors_origins() -> list[str]:
    raw = os.getenv("CORS_ALLOWED_ORIGINS", "").strip()
    if not raw:
        return list(_DEFAULT_CORS_ORIGINS)
    origins = []
    for item in raw.split(","):
        value = item.strip().rstrip("/")
        if value:
            origins.append(value)
    return origins or list(_DEFAULT_CORS_ORIGINS)

# â”€â”€ Routers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
from routers.auth     import router as auth_router
from routers.users    import router as users_router
from routers.products import router as products_router, categories_router
from routers.invoices import router as invoices_router, sessions_router
from routers.reports  import router as reports_router
from routers.returns  import router as returns_router
from routers.attendance import router as attendance_router
from routers.suppliers import router as suppliers_router
from routers.purchases import router as purchases_router
from routers.inventory import router as inventory_router
from routers.customers import router as customers_router
from routers.system_settings import router as system_settings_router
from routers.launcher import router as launcher_router

# â”€â”€ EAN-13 Validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
def is_valid_ean13(barcode: str) -> bool:
    s = str(barcode or "").strip()
    if not re.match(r"^\d{13}$", s):
        return False
    total = sum(int(s[i]) * (1 if i % 2 == 0 else 3) for i in range(12))
    return (10 - (total % 10)) % 10 == int(s[12])

_telegram_updates_task: asyncio.Task | None = None
_telegram_polling_error: str | None = None

def _env_flag(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


_ENABLE_TELEGRAM_POLLING = _env_flag("ENABLE_TELEGRAM_POLLING", True)
_AUTO_APPLY_SQLITE_COMPATIBILITY = _env_flag("AUTO_APPLY_SQLITE_COMPATIBILITY", True)

# Local HTTPS/WSS runtime replaces the previous public tunnel flow.
def _runtime_status_payload(*, db_ok: bool | None = None) -> dict:
    database_url = os.getenv("DATABASE_URL", "")
    database_backend = "postgresql" if database_url.startswith(("postgres://", "postgresql://")) else "sqlite"
    port = int(os.environ.get("PORT", 8000))
    ssl_status = get_local_ssl_runtime_status(os.getenv("FLOWPOS_APP_DATA_DIR"))
    lan_ip = str(ssl_status.get("lan_ip") or get_lan_ip())
    restart_required = bool(ssl_status.get("restart_required"))
    payload = {
        "status": "ok" if db_ok is not False else "degraded",
        "database_backend": database_backend,
        "database_ok": db_ok,
        "timezone": {
            "configured": DEFAULT_TIMEZONE,
            "resolved": str(LOCAL_TIMEZONE),
        },
        "sqlite_compatibility_auto_apply": _AUTO_APPLY_SQLITE_COMPATIBILITY,
        "local_https": {
            "enabled": True,
            "active": not restart_required,
            "lan_ip": lan_ip,
            "cert_lan_ip": ssl_status.get("cert_lan_ip"),
            "cert_covers_current_ip": ssl_status.get("cert_covers_current_ip"),
            "restart_required": restart_required,
            "port": port,
            "desktop_url": f"https://{lan_ip}:{port}/frontend-react/",
            "mobile_url": f"https://{lan_ip}:{port}/mobile-react/",
            "websocket_url_template": f"wss://{lan_ip}:{port}/ws/{{session_token}}",
            "status": ssl_status.get("status") or "ready",
            "message": ssl_status.get("message") or "صلاحية شهادة الاتصال سليمة",
        },
        "telegram_polling": {
            "enabled": _ENABLE_TELEGRAM_POLLING,
            "configured": bool(os.getenv("TELEGRAM_BOT_TOKEN")),
            "active": _telegram_updates_task is not None and not _telegram_updates_task.done(),
            "error": _telegram_polling_error,
        },
        "frontend": {
            "desktop_built": os.path.exists(FRONTEND_DIR),
            "mobile_built": os.path.exists(MOBILE_REACT_FILE),
        },
        "license": get_public_license_summary(),
    }
    return payload


def _ensure_sqlite_compatibility_schema(sync_conn):
    """Backfill missing columns on legacy SQLite databases.

    The app has historically relied on Base.metadata.create_all(), which creates
    missing tables but does not alter existing ones. When we add nullable fields
    to existing tables, old SQLite files can crash on simple SELECTs until the
    columns exist. This helper applies safe, additive ALTER TABLE statements.
    """
    if sync_conn.dialect.name != "sqlite":
        return

    inspector = inspect(sync_conn)

    products_columns = {col["name"]: col for col in inspector.get_columns("products")}
    if "default_supplier_id" not in products_columns:
        sync_conn.execute(text("ALTER TABLE products ADD COLUMN default_supplier_id INTEGER"))
    if "track_expiry" not in products_columns:
        sync_conn.execute(text("ALTER TABLE products ADD COLUMN track_expiry BOOLEAN DEFAULT 0"))
    if "track_batch" not in products_columns:
        sync_conn.execute(text("ALTER TABLE products ADD COLUMN track_batch BOOLEAN DEFAULT 0"))
    if "is_sellable" not in products_columns:
        sync_conn.execute(text("ALTER TABLE products ADD COLUMN is_sellable BOOLEAN DEFAULT 1"))
        sync_conn.execute(text("UPDATE products SET is_sellable = 1 WHERE is_sellable IS NULL"))

    # Existing products that already had an expiry date should transparently opt in.
    sync_conn.execute(text("UPDATE products SET track_expiry = 1 WHERE expiry_date IS NOT NULL AND COALESCE(track_expiry, 0) = 0"))

    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_products_default_supplier ON products(default_supplier_id)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_products_is_sellable ON products(is_sellable)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_products_active_sellable_name ON products(is_active, is_sellable, name)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_products_category_active ON products(category_id, is_active)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_invoices_cancelled_created ON invoices(is_cancelled, created_at)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_invoices_cashier_created ON invoices(cashier_id, created_at)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_invoices_payment_created ON invoices(payment_method, created_at)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_stock_movements_product_created ON stock_movements(product_id, created_at)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_product_batches_product_available_expiry ON product_batches(product_id, available_quantity, expiry_date)"))

    invoices_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "invoice_sent_to_telegram" not in invoices_columns:
        sync_conn.execute(text("ALTER TABLE invoices ADD COLUMN invoice_sent_to_telegram BOOLEAN DEFAULT 0"))
    if "invoice_telegram_sent_at" not in invoices_columns:
        sync_conn.execute(text("ALTER TABLE invoices ADD COLUMN invoice_telegram_sent_at DATETIME"))
    if "invoice_telegram_delivery_status" not in invoices_columns:
        sync_conn.execute(text("ALTER TABLE invoices ADD COLUMN invoice_telegram_delivery_status VARCHAR(20)"))

    sessions_columns = {col["name"] for col in inspector.get_columns("sessions")}
    if "mobile_bootstrap_token" not in sessions_columns:
        sync_conn.execute(text("ALTER TABLE sessions ADD COLUMN mobile_bootstrap_token VARCHAR(255)"))
    if "mobile_bootstrap_expires_at" not in sessions_columns:
        sync_conn.execute(text("ALTER TABLE sessions ADD COLUMN mobile_bootstrap_expires_at DATETIME"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_sessions_mobile_bootstrap_token ON sessions(mobile_bootstrap_token)"))

    barcode_col = products_columns.get("barcode")
    stock_col = products_columns.get("stock")
    min_stock_col = products_columns.get("min_stock")
    stock_type = type(stock_col["type"]).__name__ if stock_col else ""
    min_stock_type = type(min_stock_col["type"]).__name__ if min_stock_col else ""
    needs_decimal_stock = stock_type == "INTEGER" or min_stock_type == "INTEGER"
    if (barcode_col and not barcode_col.get("nullable", True)) or needs_decimal_stock:
        sync_conn.execute(text("PRAGMA foreign_keys=OFF"))
        sync_conn.execute(text("DROP INDEX IF EXISTS idx_products_barcode"))
        sync_conn.execute(text("DROP INDEX IF EXISTS idx_products_is_active"))
        sync_conn.execute(text("DROP INDEX IF EXISTS idx_products_is_sellable"))
        sync_conn.execute(text("DROP INDEX IF EXISTS idx_products_default_supplier"))
        sync_conn.execute(text("ALTER TABLE products RENAME TO products_legacy"))
        sync_conn.execute(text("""
            CREATE TABLE products (
                id INTEGER NOT NULL PRIMARY KEY,
                barcode VARCHAR(100) UNIQUE,
                name VARCHAR(200) NOT NULL,
                name_en VARCHAR(200),
                category_id INTEGER,
                default_supplier_id INTEGER,
                buy_price NUMERIC(10, 2) DEFAULT 0,
                price NUMERIC(10, 2) NOT NULL,
                stock NUMERIC(10, 3) DEFAULT 0,
                min_stock NUMERIC(10, 3) DEFAULT 5,
                unit VARCHAR(20) DEFAULT 'Ù‚Ø·Ø¹Ø©',
                is_weighted BOOLEAN DEFAULT 0,
                is_sellable BOOLEAN DEFAULT 1,
                track_expiry BOOLEAN DEFAULT 0,
                track_batch BOOLEAN DEFAULT 0,
                image VARCHAR(500),
                expiry_date DATETIME,
                is_active BOOLEAN DEFAULT 1,
                created_at DATETIME,
                updated_at DATETIME,
                FOREIGN KEY(category_id) REFERENCES categories (id),
                FOREIGN KEY(default_supplier_id) REFERENCES suppliers (id)
            )
        """))
        sync_conn.execute(text("""
            INSERT INTO products (
                id, barcode, name, name_en, category_id, default_supplier_id,
                buy_price, price, stock, min_stock, unit, is_weighted, is_sellable,
                track_expiry, track_batch, image, expiry_date, is_active,
                created_at, updated_at
            )
            SELECT
                id, barcode, name, name_en, category_id, default_supplier_id,
                buy_price, price, stock, min_stock, unit, is_weighted, COALESCE(is_sellable, 1),
                track_expiry, track_batch, image, expiry_date, is_active,
                created_at, updated_at
            FROM products_legacy
        """))
        sync_conn.execute(text("DROP TABLE products_legacy"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_products_is_sellable ON products(is_sellable)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS idx_products_default_supplier ON products(default_supplier_id)"))
        sync_conn.execute(text("PRAGMA foreign_keys=ON"))

def _get_lan_ip() -> str:
    return get_lan_ip()


async def _poll_telegram_customer_updates():
    global _telegram_polling_error
    offset: int | None = None

    async def load_offset() -> int | None:
        async with AsyncSessionLocal() as db:
            row = (
                await db.execute(select(SystemSetting).where(SystemSetting.key == "telegram_customer_updates_offset"))
            ).scalar_one_or_none()
            if not row or not row.value:
                return None
            try:
                return int(row.value)
            except Exception:
                return None

    async def save_offset(value: int) -> None:
        async with AsyncSessionLocal() as db:
            row = (
                await db.execute(select(SystemSetting).where(SystemSetting.key == "telegram_customer_updates_offset"))
            ).scalar_one_or_none()
            if row:
                row.value = str(value)
            else:
                db.add(SystemSetting(key="telegram_customer_updates_offset", value=str(value), description="Telegram customer activation polling offset"))
            await db.commit()

    offset = await load_offset()
    if offset is None:
        bootstrap_updates = await telegram_alerts.get_updates(timeout=1)
        if bootstrap_updates:
            try:
                offset = int(bootstrap_updates[-1].get("update_id", 0)) + 1
                await save_offset(offset)
            except Exception:
                offset = None
    while True:
        try:
            updates = await telegram_alerts.get_updates(offset=offset, timeout=15)
            _telegram_polling_error = telegram_alerts.get_updates_error()
            for update in updates:
                try:
                    offset = int(update.get("update_id", 0)) + 1
                    await save_offset(offset)
                except Exception:
                    pass

                try:
                    message = update.get("message") or update.get("edited_message") or {}
                    text_value = str(message.get("text") or "").strip()
                    if not text_value.startswith("/start"):
                        continue

                    parts = text_value.split(maxsplit=1)
                    token = parts[1].strip() if len(parts) > 1 else ""
                    chat_id = str((message.get("chat") or {}).get("id") or "")
                    username = (message.get("from") or {}).get("username")

                    if not token or not chat_id:
                        continue

                    async with AsyncSessionLocal() as db:
                        result = await process_telegram_start_token(
                            db,
                            token=token,
                            chat_id=chat_id,
                            telegram_username=str(username or "").strip() or None,
                        )

                    if result and result.get("user_id"):
                        await manager.send_to_session(
                            int(result["user_id"]),
                            str(result.get("session_token") or ""),
                            {
                                "type": "customer_telegram_status",
                                "session_token": result.get("session_token"),
                                "customer": result.get("payload"),
                            },
                        )
                except Exception as exc:
                    print(f"telegram customer update processing failed: {exc}")
        except Exception as exc:
            _telegram_polling_error = str(exc)
            print(f"telegram customer polling failed: {exc}")

        await asyncio.sleep(1)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _telegram_updates_task
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        if _AUTO_APPLY_SQLITE_COMPATIBILITY:
            await conn.run_sync(_ensure_sqlite_compatibility_schema)
    print("local HTTPS/WSS mode active on port 8000; public tunnel runtime is disabled.")
    if _ENABLE_TELEGRAM_POLLING and os.getenv("TELEGRAM_BOT_TOKEN"):
        _telegram_updates_task = asyncio.create_task(_poll_telegram_customer_updates())
    elif _ENABLE_TELEGRAM_POLLING:
        print("Telegram polling enabled, but TELEGRAM_BOT_TOKEN is not configured.")
    else:
        print("Telegram polling disabled by ENABLE_TELEGRAM_POLLING=false.")
    yield
    if _telegram_updates_task:
        _telegram_updates_task.cancel()
        try:
            await _telegram_updates_task
        except asyncio.CancelledError:
            pass
        _telegram_updates_task = None

# â”€â”€ App â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app = FastAPI(title="Ø³Ø±ÙŠØ¹ API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_cors_origins(),
    allow_origin_regex=os.getenv("CORS_ALLOWED_ORIGIN_REGEX", _DEFAULT_CORS_REGEX),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _is_license_exempt_path(path: str) -> bool:
    return (
        path == "/"
        or path.startswith("/health")
        or path.startswith("/ready")
        or path.startswith("/install-ca")
        or path.startswith("/local-root-ca.pem")
        or path.startswith("/local-root-ca.cer")
        or path.startswith("/local-root-ca.mobileconfig")
        or path.startswith("/launcher/")
        or path.startswith("/frontend-react/assets/")
        or path.startswith("/mobile-react/assets/")
        or path == "/frontend-react/favicon.svg"
    )


def _is_browser_document_request(request: StarletteRequest) -> bool:
    accept = str(request.headers.get("accept") or "").lower()
    fetch_dest = str(request.headers.get("sec-fetch-dest") or "").lower()
    path = request.url.path
    return (
        "text/html" in accept
        or fetch_dest == "document"
        or path in {"/frontend-react", "/frontend-react/", "/mobile-react", "/mobile-react/"}
    )


def _license_blocked_html(payload: dict) -> HTMLResponse:
    reason = str(payload.get("reason") or payload.get("status_reason") or "").strip()
    subscription_term = str(payload.get("subscription_term") or "").strip()
    expires_at = str(payload.get("expires_at") or payload.get("trial_expires_at") or "").strip()
    renewal_url = build_activation_request_url(
        store_name=None,
        store_type=None,
        country=None,
        currency=None,
        store_id=str(payload.get("store_id") or "").strip() or None,
        license_status=str(payload.get("license_status") or "").strip() or None,
    )

    if reason == "trial_expired":
        heading = "Ø§Ù†ØªÙ‡Øª Ø§Ù„ÙØªØ±Ø© Ø§Ù„ØªØ¬Ø±ÙŠØ¨ÙŠØ©"
        message = "ØªÙ… Ø¥ÙŠÙ‚Ø§Ù Ø§Ù„ÙˆØµÙˆÙ„ Ø¥Ù„Ù‰ Ø§Ù„Ù†Ø¸Ø§Ù… Ø­ØªÙ‰ ÙŠØªÙ… Ø¥Ø¯Ø®Ø§Ù„ Ø±Ù…Ø² ØªÙØ¹ÙŠÙ„ ØµØ§Ù„Ø­ Ù„Ù‡Ø°Ø§ Ø§Ù„Ù…ØªØ¬Ø± ÙˆÙ‡Ø°Ø§ Ø§Ù„Ø¬Ù‡Ø§Ø²."
        action_label = "Ø·Ù„Ø¨ Ø§Ù„ØªÙØ¹ÙŠÙ„"
    elif reason == "license_expired":
        heading = "Ø§Ù†ØªÙ‡Ù‰ Ø§Ù„Ø§Ø´ØªØ±Ø§Ùƒ"
        message = "Ø§Ù†ØªÙ‡Øª ØµÙ„Ø§Ø­ÙŠØ© Ø§Ù„Ø§Ø´ØªØ±Ø§Ùƒ Ø§Ù„Ø­Ø§Ù„ÙŠØŒ ÙˆÙŠØ¬Ø¨ Ø¥Ø¯Ø®Ø§Ù„ Ø±Ù…Ø² ØªØ¬Ø¯ÙŠØ¯ Ø¬Ø¯ÙŠØ¯ Ù‚Ø¨Ù„ Ù…ØªØ§Ø¨Ø¹Ø© Ø§Ø³ØªØ®Ø¯Ø§Ù… Ø§Ù„Ù†Ø¸Ø§Ù…."
        action_label = "Ø·Ù„Ø¨ Ø§Ù„ØªØ¬Ø¯ÙŠØ¯"
    else:
        heading = "Ø§Ù„Ù†Ø¸Ø§Ù… Ø¨Ø­Ø§Ø¬Ø© Ø¥Ù„Ù‰ ØªÙØ¹ÙŠÙ„"
        message = "Ù„Ø§ ÙŠÙ…ÙƒÙ† Ù…ØªØ§Ø¨Ø¹Ø© Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù…Ù† Ø§Ù„Ø±Ø§Ø¨Ø· Ø§Ù„Ù…Ø¨Ø§Ø´Ø± Ù‚Ø¨Ù„ ØªÙØ¹ÙŠÙ„ Ø§Ù„Ù†Ø³Ø®Ø© Ø§Ù„Ø­Ø§Ù„ÙŠØ© Ù…Ù† Ø®Ù„Ø§Ù„ Ø§Ù„Ù„Ø§Ù†Ø´Ø±."
        action_label = "Ø·Ù„Ø¨ Ø§Ù„ØªÙØ¹ÙŠÙ„"

    expiry_line = f"<div class='meta-row'><strong>Ø§Ù†ØªÙ‡Ø§Ø¡ Ø§Ù„ØªØ±Ø®ÙŠØµ:</strong><span>{expires_at}</span></div>" if expires_at else ""
    term_line = f"<div class='meta-row'><strong>Ù†ÙˆØ¹ Ø§Ù„Ø§Ø´ØªØ±Ø§Ùƒ:</strong><span>{subscription_term}</span></div>" if subscription_term else ""

    html = f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ø³Ø±ÙŠØ¹ | Ø§Ù„ÙˆØµÙˆÙ„ Ù…ÙˆÙ‚ÙˆÙ</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f6f7fb;
      --card: rgba(255,255,255,0.86);
      --line: rgba(15,23,42,0.08);
      --text: #172033;
      --muted: #6b7280;
      --brand: #f59e0b;
      --brand-strong: #f57c00;
      --shadow: 0 22px 60px rgba(15,23,42,0.12);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", Tahoma, Arial, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top right, rgba(245, 158, 11, 0.16), transparent 28%),
        radial-gradient(circle at bottom left, rgba(245, 124, 0, 0.10), transparent 24%),
        var(--bg);
      display: grid;
      place-items: center;
      padding: 24px;
    }}
    .shell {{
      width: min(760px, 100%);
      border: 1px solid var(--line);
      background: var(--card);
      backdrop-filter: blur(18px);
      border-radius: 32px;
      box-shadow: var(--shadow);
      padding: 40px 36px;
    }}
    .eyebrow {{
      color: var(--brand-strong);
      font-weight: 800;
      margin-bottom: 10px;
    }}
    h1 {{
      margin: 0 0 14px;
      font-size: clamp(2rem, 3vw, 2.8rem);
      line-height: 1.2;
    }}
    p {{
      margin: 0;
      color: var(--muted);
      font-size: 1.02rem;
      line-height: 1.9;
    }}
    .meta {{
      margin-top: 26px;
      border-top: 1px solid var(--line);
      padding-top: 18px;
      display: grid;
      gap: 10px;
    }}
    .meta-row {{
      display: flex;
      justify-content: space-between;
      gap: 16px;
      font-size: 0.98rem;
    }}
    .meta-row strong {{
      color: var(--text);
    }}
    .meta-row span {{
      color: var(--muted);
      text-align: left;
      direction: ltr;
    }}
    .actions {{
      margin-top: 28px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }}
    .btn {{
      border: 0;
      border-radius: 18px;
      padding: 14px 20px;
      font-size: 0.96rem;
      font-weight: 800;
      text-decoration: none;
      cursor: pointer;
      transition: transform 140ms ease, box-shadow 140ms ease, opacity 140ms ease;
    }}
    .btn:hover {{
      transform: translateY(-1px);
    }}
    .btn-primary {{
      color: white;
      background: linear-gradient(135deg, var(--brand), var(--brand-strong));
      box-shadow: 0 18px 34px rgba(245, 124, 0, 0.22);
    }}
    .btn-secondary {{
      color: var(--text);
      background: white;
      border: 1px solid var(--line);
    }}
  </style>
</head>
<body>
  <main class="shell">
    <div class="eyebrow">Ø³Ø±ÙŠØ¹ | Ø§Ù„ØªÙØ¹ÙŠÙ„</div>
    <h1>{heading}</h1>
    <p>{message}</p>
    <div class="meta">
      <div class="meta-row"><strong>Ø§Ù„Ø­Ø§Ù„Ø©:</strong><span>{payload.get("license_status") or "blocked"}</span></div>
      {term_line}
      {expiry_line}
    </div>
    <div class="actions">
      <a class="btn btn-primary" href="{renewal_url}" target="_blank" rel="noreferrer">{action_label} Ø¹Ø¨Ø± ÙˆØ§ØªØ³Ø§Ø¨</a>
      <a class="btn btn-secondary" href="/">Ø§Ù„Ø¹ÙˆØ¯Ø©</a>
    </div>
  </main>
</body>
</html>"""
    return HTMLResponse(status_code=403, content=html)


class LicenseGuardMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        if _is_license_exempt_path(request.url.path):
            return await call_next(request)
        if should_block_usage():
            payload = get_public_license_summary()
            if _is_browser_document_request(request):
                return _license_blocked_html(payload)
            return JSONResponse(
                status_code=403,
                content={
                    "detail": "LICENSE_BLOCKED",
                    "license": payload,
                },
            )
        return await call_next(request)


app.add_middleware(LicenseGuardMiddleware)

# â”€â”€ Static Files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))


def _resolve_frontend_dist() -> str:
    configured = os.getenv("FLOWPOS_FRONTEND_DIST", "").strip()
    if configured:
        return os.path.normpath(configured)

    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            bundled = os.path.join(meipass, "frontend", "dist")
            if os.path.exists(bundled):
                return os.path.normpath(bundled)

    return os.path.normpath(os.path.join(BASE_DIR, "..", "frontend", "dist"))


FRONTEND_DIR = _resolve_frontend_dist()
MOBILE_REACT_FILE = os.path.join(FRONTEND_DIR, "mobile.html")

if os.path.exists(FRONTEND_DIR):
    app.mount("/frontend-react", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend-react")

# â”€â”€ Register Routers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.include_router(auth_router)
app.include_router(users_router)
app.include_router(products_router)
app.include_router(categories_router)
app.include_router(sessions_router)
app.include_router(invoices_router)
app.include_router(reports_router)
app.include_router(returns_router)
app.include_router(attendance_router)
app.include_router(suppliers_router)
app.include_router(purchases_router)
app.include_router(inventory_router)
app.include_router(customers_router)
app.include_router(system_settings_router)
app.include_router(launcher_router)

# â”€â”€ Root & Network Info â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.get("/")
async def root():
    payload = {"status": "ok"}
    if os.path.exists(FRONTEND_DIR):
        payload["frontend_react"] = "/frontend-react/"
    if os.path.exists(MOBILE_REACT_FILE):
        payload["mobile_react"] = "/mobile-react/"
    return payload


@app.get("/health")
async def health():
    return _runtime_status_payload()


@app.get("/ready")
async def ready():
    db_ok = False
    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False
    return _runtime_status_payload(db_ok=db_ok)

@app.get("/mobile-react")
@app.get("/mobile-react/")
async def mobile_react():
    if not os.path.exists(MOBILE_REACT_FILE):
        raise HTTPException(404, "ÙˆØ§Ø¬Ù‡Ø© Ø§Ù„Ù…ÙˆØ¨Ø§ÙŠÙ„ Ø§Ù„Ø­Ø¯ÙŠØ«Ø© ØºÙŠØ± Ù…Ø¨Ù†ÙŠØ© Ø¨Ø¹Ø¯")
    return FileResponse(MOBILE_REACT_FILE)

@app.get("/install-ca")
async def install_ca_page(
    next_url: str | None = Query(default=None, alias="next"),
    cert_only: bool = Query(default=False),
):
    port = int(os.environ.get("PORT", 8000))
    lan_ip = get_lan_ip()
    local_origin = f"https://{lan_ip}:{port}"
    scanner_url = f"{local_origin}/mobile-react/"
    if next_url:
        candidate = next_url.strip()
        if candidate.startswith(f"{local_origin}/mobile-react"):
            scanner_url = candidate
    safe_scanner_url = escape(scanner_url, quote=True)
    scanner_button = (
        f'<a class="button secondary" href="{safe_scanner_url}">فتح ماسح سريع</a>'
        if not cert_only
        else '<div class="hint"><strong>مهم:</strong> على iPhone لا تفتح الماسح قبل تثبيت الشهادة ثم تفعيل Full Trust من Certificate Trust Settings.</div>'
    )
    html = f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>سريع | إعداد الاتصال الآمن</title>
  <style>
    * {{ box-sizing: border-box; }}
    body {{ margin:0; font-family: Tahoma, Arial, sans-serif; background: linear-gradient(145deg,#fff7ed,#f8fafc); color:#172033; }}
    main {{ max-width: 760px; margin: 0 auto; padding: 28px 18px; }}
    .card {{ background: rgba(255,255,255,.88); border:1px solid rgba(15,23,42,.08); border-radius:28px; padding:24px; box-shadow:0 22px 60px rgba(15,23,42,.12); }}
    h1 {{ margin:0 0 10px; font-size:1.9rem; }}
    p, li {{ line-height:1.85; color:#5b6475; }}
    a.button {{ display:block; text-align:center; margin:18px 0; padding:15px 18px; border-radius:18px; background:linear-gradient(135deg,#f59e0b,#f57c00); color:white; font-weight:800; text-decoration:none; }}
    a.button.secondary {{ background: #172033; }}
    .hint {{ background:#fff7ed; border:1px solid rgba(245,124,0,.18); border-radius:18px; padding:14px; }}
    .warning {{ background:#fff1f2; border:1px solid rgba(244,63,94,.22); border-radius:18px; padding:14px; margin: 14px 0; }}
    .browser-rule {{ display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin:16px 0; }}
    .browser-rule div {{ background:#eef6ff; border:1px solid rgba(37,99,235,.16); border-radius:18px; padding:14px; color:#172033; font-weight:800; }}
    .browser-rule span {{ display:block; margin-top:6px; color:#5b6475; font-size:.95rem; font-weight:600; }}
    .platform {{ margin-top: 16px; }}
    @media (max-width: 620px) {{ .browser-rule {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>إعداد الماسح الآمن</h1>
      <p>لتشغيل ماسح سريع محليًا بدون إنترنت، ثبّت شهادة الثقة على هذا الموبايل ثم فعّل الثقة الكاملة لها.</p>
      <div class="browser-rule" aria-label="المتصفحات المعتمدة">
        <div>iPhone: Safari فقط<span>لا تستخدم Chrome على iPhone لتثبيت الشهادة أو فتح الماسح.</span></div>
        <div>Android: Google Chrome فقط<span>تجنب المتصفح الداخلي للتطبيقات أو المتصفحات غير المعروفة.</span></div>
      </div>
      <div class="warning">
        على iPhone استخدم Safari فقط لتثبيت الشهادة وتشغيل الماسح. إذا ظهر تنبيه أن الصفحة غير آمنة في Safari، اضغط <strong>إظهار التفاصيل</strong> ثم <strong>زيارة هذا الموقع</strong> مرة واحدة فقط حتى تصل لصفحة تنزيل الشهادة.
      </div>
      <div class="warning">
        لا تحذف شهادة سريع أو ملف الثقة من الموبايل بعد تفعيلها؛ حذفها سيجعل الماسح يظهر رسالة أن الاتصال غير آمن مرة أخرى، وستحتاج إلى تثبيتها وتفعيلها من جديد.
      </div>
      <a class="button" href="/local-root-ca.mobileconfig" download="flowpos-saree-root-ca.mobileconfig">iPhone: تحميل ملف الثقة Profile</a>
      <a class="button secondary" href="/local-root-ca.cer" download="flowpos-saree-root-ca.cer">Android: تحميل شهادة الثقة CER</a>
      <div class="hint">
        <strong>Android:</strong>
        <ol>
          <li>استخدم Google Chrome لفتح رابط التثبيت والماسح، ولا تستخدم المتصفح الداخلي للتطبيقات أو متصفحًا غير معروف.</li>
          <li>افتح ملف الشهادة بعد التحميل.</li>
          <li>اختر تثبيت كشهادة CA من إعدادات الأمان.</li>
          <li>بعد التثبيت ارجع لهذه الصفحة وافتح الماسح.</li>
        </ol>
        <strong class="platform">iPhone:</strong>
        <ol>
          <li>استخدم Safari على iPhone. إذا فتح الرابط داخل Chrome وظهر تحذير، افتحه من Safari بعد تفعيل Full Trust.</li>
          <li>اضغط زر <strong>iPhone: تحميل ملف الثقة Profile</strong>.</li>
          <li>افتح تطبيق Settings، وسيظهر خيار <strong>Install Profile</strong> أعلى الصفحة الرئيسية.</li>
          <li>اضغط Install Profile وثبّت شهادة سريع.</li>
          <li>بعد انتهاء التثبيت، اذهب إلى: Settings → General → About → Certificate Trust Settings.</li>
          <li>فعّل خيار <strong>Full Trust</strong> لشهادة FlowPOS / Saree.</li>
          <li>بعد تفعيل Full Trust فقط، ارجع وافتح رابط الماسح أو امسح QR الماسح من شاشة الكاشير.</li>
        </ol>
      </div>
      {scanner_button}
    </section>
  </main>
</body>
</html>"""
    return HTMLResponse(html)

@app.get("/local-root-ca.pem")
async def local_root_ca():
    app_data_dir = os.getenv("FLOWPOS_APP_DATA_DIR", "")
    path = os.path.join(app_data_dir, "ssl", "root_ca.pem")
    if not app_data_dir or not os.path.exists(path):
        raise HTTPException(404, "شهادة الثقة غير جاهزة بعد")
    return FileResponse(path, media_type="application/x-pem-file", filename="flowpos-saree-root-ca.pem")


@app.get("/local-root-ca.cer")
async def local_root_ca_cer():
    app_data_dir = os.getenv("FLOWPOS_APP_DATA_DIR", "")
    path = os.path.join(app_data_dir, "ssl", "root_ca.pem")
    if not app_data_dir or not os.path.exists(path):
        raise HTTPException(404, "شهادة الثقة غير جاهزة بعد")
    try:
        with open(path, "rb") as cert_file:
            cert = x509.load_pem_x509_certificate(cert_file.read())
    except Exception:
        raise HTTPException(500, "تعذر تجهيز شهادة الثقة للموبايل")
    return Response(
        cert.public_bytes(serialization.Encoding.DER),
        media_type="application/x-x509-ca-cert",
        headers={"Content-Disposition": 'attachment; filename="flowpos-saree-root-ca.cer"'},
    )


@app.get("/local-root-ca.mobileconfig")
async def local_root_ca_mobileconfig():
    app_data_dir = os.getenv("FLOWPOS_APP_DATA_DIR", "")
    path = os.path.join(app_data_dir, "ssl", "root_ca.pem")
    if not app_data_dir or not os.path.exists(path):
        raise HTTPException(404, "شهادة الثقة غير جاهزة بعد")
    try:
        with open(path, "rb") as cert_file:
            cert = x509.load_pem_x509_certificate(cert_file.read())
        cert_der = cert.public_bytes(serialization.Encoding.DER)
    except Exception:
        raise HTTPException(500, "تعذر تجهيز ملف الثقة للآيفون")

    profile_uuid = str(uuid.uuid5(uuid.NAMESPACE_DNS, "flowpos.saree.local.root.profile"))
    cert_uuid = str(uuid.uuid5(uuid.NAMESPACE_DNS, "flowpos.saree.local.root.cert"))
    profile = {
        "PayloadContent": [
            {
                "PayloadCertificateFileName": "flowpos-saree-root-ca.cer",
                "PayloadContent": cert_der,
                "PayloadDescription": "FlowPOS Saree local Root CA for secure LAN scanner access.",
                "PayloadDisplayName": "FlowPOS Saree Local Root CA",
                "PayloadIdentifier": "com.flowpos.saree.local.rootca.cert",
                "PayloadType": "com.apple.security.root",
                "PayloadUUID": cert_uuid,
                "PayloadVersion": 1,
            }
        ],
        "PayloadDescription": "Installs the FlowPOS Saree local Root CA. After installation, enable Full Trust in Certificate Trust Settings.",
        "PayloadDisplayName": "FlowPOS Saree Local Root CA",
        "PayloadIdentifier": "com.flowpos.saree.local.rootca",
        "PayloadOrganization": "FlowPOS Saree",
        "PayloadRemovalDisallowed": False,
        "PayloadType": "Configuration",
        "PayloadUUID": profile_uuid,
        "PayloadVersion": 1,
    }
    return Response(
        plistlib.dumps(profile),
        media_type="application/x-apple-aspen-config",
        headers={"Content-Disposition": 'attachment; filename="flowpos-saree-root-ca.mobileconfig"'},
    )

@app.get("/server-ip")
async def server_ip(_=Depends(get_current_user)):
    return {"ip": _get_lan_ip()}

@app.get("/local-mobile-url")
async def local_mobile_url(_=Depends(get_current_user)):
    port = int(os.environ.get("PORT", 8000))
    ssl_status = get_local_ssl_runtime_status(os.getenv("FLOWPOS_APP_DATA_DIR"))
    lan_ip = str(ssl_status.get("lan_ip") or get_lan_ip())
    restart_required = bool(ssl_status.get("restart_required"))
    return {
        "url": f"https://{lan_ip}:{port}",
        "mobile_url": f"https://{lan_ip}:{port}/mobile-react/",
        "websocket_url_template": f"wss://{lan_ip}:{port}/ws/{{session_token}}",
        "active": not restart_required,
        "mode": "local_https",
        "lan_ip": lan_ip,
        "cert_lan_ip": ssl_status.get("cert_lan_ip"),
        "cert_covers_current_ip": ssl_status.get("cert_covers_current_ip"),
        "restart_required": restart_required,
        "message": ssl_status.get("message"),
        "port": port,
    }

# â”€â”€ WebSocket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
manager = ConnectionManager()
_WS_SESSION_STALE_SECONDS = 300
_WS_SESSION_RECOVERY_SECONDS = 60 * 60 * 12
_WS_PRESENCE_TOUCH_INTERVAL_SECONDS = 60
_WS_SCAN_ID_TTL_SECONDS = 120
_ws_presence_last_touched: dict[str, datetime] = {}
_ws_seen_scan_ids: dict[str, dict[str, datetime]] = {}


def _session_has_only_placeholder_timestamps(session: CashierSession) -> bool:
    if session.last_activity_at is None:
        return True
    try:
        return abs((session.last_activity_at - session.opened_at).total_seconds()) < 2
    except Exception:
        return False


def _socket_session_is_stale(session: CashierSession, now: datetime | None = None) -> bool:
    last_seen = session.last_activity_at or session.opened_at
    if not last_seen:
        return False
    now = now or utc_now()
    return (now - last_seen).total_seconds() > _WS_SESSION_STALE_SECONDS


def _socket_session_can_recover(session: CashierSession, now: datetime | None = None) -> bool:
    if session.is_active:
        return True
    if session.disconnect_reason == "manual_close":
        return False
    last_seen = session.closed_at or session.last_activity_at or session.opened_at
    if not last_seen:
        return False
    now = now or utc_now()
    return (now - last_seen).total_seconds() <= _WS_SESSION_RECOVERY_SECONDS


async def _split_stale_socket_session(db: AsyncSession, session: CashierSession) -> CashierSession:
    old_token = session.session_token
    last_seen = session.last_activity_at or session.opened_at or utc_now()
    session.session_token = f"{old_token}:closed:{uuid.uuid4().hex[:8]}"
    session.is_active = False
    session.closed_at = last_seen
    session.disconnect_reason = "timeout"
    session.is_abnormal = True

    replacement = CashierSession(
        user_id=session.user_id,
        session_token=old_token,
        is_active=True,
        opened_at=utc_now(),
        last_activity_at=None,
        closed_at=None,
        disconnect_reason="active",
        is_abnormal=False,
    )
    db.add(replacement)
    await db.commit()
    await db.refresh(replacement)
    return replacement


async def _prepare_socket_session(db: AsyncSession, session: CashierSession) -> CashierSession:
    if _socket_session_is_stale(session):
        return await _split_stale_socket_session(db, session)
    return session


async def _recover_socket_session(db: AsyncSession, session_token: str) -> CashierSession | None:
    result = await db.execute(
        select(CashierSession).where(CashierSession.session_token == session_token).order_by(CashierSession.id.desc())
    )
    session = result.scalars().first()
    if not session or not _socket_session_can_recover(session):
        return None

    active_for_user = await db.execute(
        select(CashierSession).where(
            CashierSession.user_id == session.user_id,
            CashierSession.is_active == True,
            CashierSession.session_token != session_token,
        )
    )
    if active_for_user.scalar_one_or_none():
        return None

    session.is_active = True
    session.closed_at = None
    session.disconnect_reason = "recovered"
    session.is_abnormal = False
    await db.commit()
    await db.refresh(session)
    return session


async def _mark_session_connected(db: AsyncSession, session: CashierSession):
    now = utc_now()
    if _session_has_only_placeholder_timestamps(session):
        session.opened_at = now
    session.last_activity_at = now
    session.is_active = True
    session.closed_at = None
    session.disconnect_reason = "active"
    await db.commit()


async def _touch_session_presence(db: AsyncSession, session: CashierSession):
    now = utc_now()
    last_touched = _ws_presence_last_touched.get(session.session_token)
    if last_touched and (now - last_touched).total_seconds() < _WS_PRESENCE_TOUCH_INTERVAL_SECONDS:
        return
    _ws_presence_last_touched[session.session_token] = now
    session.last_activity_at = now
    await db.commit()


def _mark_scan_id_seen(session_token: str, scan_id: str | None) -> bool:
    if not scan_id:
        return False

    now = utc_now()
    bucket = _ws_seen_scan_ids.setdefault(session_token, {})
    stale = [
        key
        for key, seen_at in bucket.items()
        if (now - seen_at).total_seconds() > _WS_SCAN_ID_TTL_SECONDS
    ]
    for key in stale:
        bucket.pop(key, None)

    if scan_id in bucket:
        return True
    bucket[scan_id] = now
    return False

@app.websocket("/ws/{session_token}")
async def websocket_endpoint(
    websocket: WebSocket,
    session_token: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(CashierSession).where(
            CashierSession.session_token == session_token,
            CashierSession.is_active == True,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        session = await _recover_socket_session(db, session_token)
        if not session:
            await websocket.close(code=4001)
            return

    session = await _prepare_socket_session(db, session)
    await _mark_session_connected(db, session)
    await manager.connect(websocket, session.user_id, session_token)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            msg_type = msg.get("type")

            if msg_type == "scan_barcode":
                barcode = str(msg.get("barcode", "")).strip()
                scan_id = str(msg.get("scan_id", "")).strip() or None

                if _mark_scan_id_seen(session.session_token, scan_id):
                    await websocket.send_text(json.dumps({
                        "type": "duplicate_scan_ignored",
                        "session_token": session.session_token,
                        "scan_id": scan_id,
                    }, ensure_ascii=False))
                    continue

                if not is_valid_ean13(barcode):
                    await manager.send_to_session(session.user_id, session.session_token, {
                        "type": "product_not_found",
                        "barcode": barcode,
                        "scan_id": scan_id,
                        "reason": "invalid_ean13",
                    })
                    continue

                # exact primary
                res = await db.execute(
                    select(Product).where(
                        Product.barcode == barcode,
                        Product.is_active == True,
                        Product.is_sellable == True,
                    )
                )
                product = res.scalar_one_or_none()

                # exact alias â€” FIX 3: ØªØ£ÙƒØ¯ Ø£Ù† Ø§Ù„Ù…Ù†ØªØ¬ Ø§Ù„Ù…Ø±ØªØ¨Ø· Ù†Ø´Ø·
                if not product:
                    alias = (await db.execute(
                        select(ProductBarcode).where(ProductBarcode.barcode == barcode)
                    )).scalar_one_or_none()
                    if alias:
                        product = (await db.execute(
                            select(Product).where(
                                Product.id == alias.product_id,
                                Product.is_active == True,
                                Product.is_sellable == True,
                            )
                        )).scalar_one_or_none()

                if product:
                    await manager.send_to_session(session.user_id, session.session_token, {
                        "type": "product_found",
                        "session_token": session.session_token,
                        "scan_id": scan_id,
                        "product": {
                            "id": product.id, "name": product.name,
                            "barcode": product.barcode,
                            "price": float(product.price),
                            "stock": float(product.stock or 0),
                            "image": product.image,
                            "category_id": product.category_id,
                            "is_weighted": bool(product.is_weighted),
                            "is_sellable": bool(product.is_sellable),
                        }
                    })
                else:
                    await manager.send_to_session(session.user_id, session.session_token, {
                        "type": "product_not_found",
                        "session_token": session.session_token,
                        "scan_id": scan_id,
                        "barcode": barcode,
                    })

            elif msg_type == "mobile_ready":
                manager.mark_client_type(websocket, "mobile")
                await manager.send_to_session(session.user_id, session.session_token, {
                    "type": "mobile_ready",
                    "session": session.session_token,
                })
                await websocket.send_text(json.dumps({"type": "desktop_ready"}))

            elif msg_type == "desktop_ready":
                manager.mark_client_type(websocket, "desktop")
                if manager.has_client_type_connections(session.user_id, session.session_token, "mobile"):
                    await websocket.send_text(json.dumps({
                        "type": "mobile_ready",
                        "session": session.session_token,
                    }))
                else:
                    await websocket.send_text(json.dumps({
                        "type": "mobile_disconnected",
                        "session": session.session_token,
                    }))
                await manager.send_to_session(session.user_id, session.session_token, {
                    "type": "desktop_ready",
                    "session": session.session_token,
                })

            elif msg_type == "add_product_request":
                await manager.send_to_session(session.user_id, session.session_token, {
                    "type": "add_product_request",
                    "session_token": session.session_token,
                    "barcode": msg.get("barcode", ""),
                })

            elif msg_type == "customer_activation_open":
                await manager.send_to_session(session.user_id, session.session_token, {
                    "type": "customer_activation_open",
                    "session_token": session.session_token,
                    "customer": msg.get("customer"),
                })

            elif msg_type == "ping":
                await _touch_session_presence(db, session)
                await websocket.send_text(json.dumps({
                    "type": "pong",
                    "session_token": session.session_token,
                }, ensure_ascii=False))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"websocket session failed: {exc.__class__.__name__}")
    finally:
        client_type = manager.get_client_type(websocket)
        manager.disconnect(websocket)
        try:
            still_connected = manager.has_session_connections(session.user_id, session_token)
            if session and session.is_active and not still_connected:
                session.disconnect_reason = "dropped"
                session.is_abnormal = False
                await db.commit()
            if client_type == "mobile" and not manager.has_client_type_connections(session.user_id, session_token, "mobile"):
                await manager.send_to_session(session.user_id, session_token, {
                    "type": "mobile_disconnected",
                    "session": session.session_token,
                })
        except BaseException:
            pass


