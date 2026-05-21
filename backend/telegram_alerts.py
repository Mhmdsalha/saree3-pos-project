"""
Telegram helpers for manager alerts, customer activation, and document delivery.

Values are read from the environment at call time instead of import time so the
module still works when `load_dotenv()` runs later during app startup.
"""

import logging
import os
from typing import Optional

import httpx
from sqlalchemy import select

from database import AsyncSessionLocal
from models import StoreProfile, SystemSetting
from services.timezone_service import local_now

logger = logging.getLogger(__name__)

TELEGRAM_STORE_CHAT_ID_KEY = "telegram_store_chat_id"
DEFAULT_TELEGRAM_BOT_USERNAME = "flowpos_alerts_bot"
_last_updates_error: str | None = None


def _log_telegram_failure(operation: str, exc: Exception) -> None:
    logger.warning("Telegram %s failed: %s", operation, exc.__class__.__name__)


def _bot_token() -> str:
    return os.getenv("TELEGRAM_BOT_TOKEN", "").strip()


def is_bot_token_configured() -> bool:
    return bool(_bot_token())


def _chat_id() -> str:
    return os.getenv("TELEGRAM_CHAT_ID", "").strip()


def _bot_username_setting() -> str:
    configured = os.getenv("TELEGRAM_BOT_USERNAME", "").strip().lstrip("@")
    if configured:
        return configured
    return os.getenv("FLOWPOS_DEFAULT_TELEGRAM_BOT_USERNAME", DEFAULT_TELEGRAM_BOT_USERNAME).strip().lstrip("@")


def _is_configured() -> bool:
    return bool(_bot_token() and _chat_id())


def _scoped_store_setting_key(base_key: str, store_id: str | None) -> str:
    scoped_store_id = str(store_id or "").strip()
    return f"{base_key}:{scoped_store_id}" if scoped_store_id else base_key


def _mask_chat_id(chat_id: str | None) -> str:
    value = str(chat_id or "").strip()
    if len(value) <= 4:
        return "****" if value else ""
    return f"{value[:2]}***{value[-2:]}"


async def _resolve_store_manager_chat_id(store_id: str | None = None) -> tuple[str | None, str | None]:
    try:
        async with AsyncSessionLocal() as db:
            resolved_store_id = str(store_id or "").strip()
            if not resolved_store_id:
                profile = (await db.execute(select(StoreProfile).order_by(StoreProfile.id.asc()))).scalar_one_or_none()
                resolved_store_id = str(profile.store_id or "").strip() if profile else ""
            if not resolved_store_id:
                return None, None

            setting_key = _scoped_store_setting_key(TELEGRAM_STORE_CHAT_ID_KEY, resolved_store_id)
            res = await db.execute(select(SystemSetting).where(SystemSetting.key == setting_key))
            setting = res.scalar_one_or_none()
            chat_id = str(setting.value or "").strip() if setting and setting.value else ""
            return (chat_id or None), resolved_store_id
    except Exception as exc:
        _log_telegram_failure("resolve store manager chat", exc)
        return None, store_id


async def send_alert(message: str, *, store_id: str | None = None) -> bool:
    token = _bot_token()
    chat_id, resolved_store_id = await _resolve_store_manager_chat_id(store_id)
    if not token or not chat_id:
        logger.info(
            "Telegram store alert skipped: token_configured=%s store_id=%s chat_configured=%s",
            bool(token),
            resolved_store_id or store_id,
            bool(chat_id),
        )
        return False
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                url,
                json={
                    "chat_id": chat_id,
                    "text": message,
                    "parse_mode": "HTML",
                },
            )
            ok = resp.status_code == 200
            logger.info(
                "Telegram store alert result: store_id=%s chat=%s ok=%s status=%s",
                resolved_store_id or store_id,
                _mask_chat_id(chat_id),
                ok,
                resp.status_code,
            )
            return ok
    except Exception as exc:
        _log_telegram_failure("alert", exc)
        return False


async def send_message_to_chat(chat_id: str, message: str, *, parse_mode: str | None = None) -> bool:
    token = _bot_token()
    if not token or not chat_id:
        return False
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": str(chat_id),
            "text": message,
        }
        if parse_mode:
            payload["parse_mode"] = parse_mode
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json=payload)
            return resp.status_code == 200
    except Exception as exc:
        _log_telegram_failure("chat message", exc)
        return False


async def send_document(filename: str, data: bytes, caption: Optional[str] = None, *, store_id: str | None = None) -> bool:
    token = _bot_token()
    chat_id, resolved_store_id = await _resolve_store_manager_chat_id(store_id)
    if not token or not chat_id:
        logger.info(
            "Telegram store document skipped: token_configured=%s store_id=%s chat_configured=%s",
            bool(token),
            resolved_store_id or store_id,
            bool(chat_id),
        )
        return False
    try:
        url = f"https://api.telegram.org/bot{token}/sendDocument"
        files = {
            "document": (filename, data, "application/pdf"),
        }
        payload = {
            "chat_id": chat_id,
        }
        if caption:
            payload["caption"] = caption

        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(url, data=payload, files=files)
            ok = resp.status_code == 200
            logger.info(
                "Telegram store document result: store_id=%s chat=%s ok=%s status=%s",
                resolved_store_id or store_id,
                _mask_chat_id(chat_id),
                ok,
                resp.status_code,
            )
            return ok
    except Exception as exc:
        _log_telegram_failure("document send", exc)
        return False


async def send_document_to_chat(chat_id: str, filename: str, data: bytes, caption: Optional[str] = None) -> bool:
    token = _bot_token()
    if not token or not chat_id:
        return False
    try:
        url = f"https://api.telegram.org/bot{token}/sendDocument"
        files = {
            "document": (filename, data, "application/pdf"),
        }
        payload = {
            "chat_id": str(chat_id),
        }
        if caption:
            payload["caption"] = caption

        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(url, data=payload, files=files)
            return resp.status_code == 200
    except Exception as exc:
        _log_telegram_failure("document send to chat", exc)
        return False


async def get_bot_username() -> str | None:
    configured_username = _bot_username_setting()
    if configured_username:
        return configured_username

    token = _bot_token()
    if not token:
        return None

    try:
        url = f"https://api.telegram.org/bot{token}/getMe"
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            return None
        data = resp.json() or {}
        result = data.get("result") or {}
        username = str(result.get("username") or "").strip().lstrip("@")
        return username or None
    except Exception as exc:
        _log_telegram_failure("getMe", exc)
        return None


async def get_updates(offset: int | None = None, timeout: int = 15) -> list[dict]:
    global _last_updates_error
    token = _bot_token()
    if not token:
        _last_updates_error = "missing_bot_token"
        return []
    try:
        url = f"https://api.telegram.org/bot{token}/getUpdates"
        payload: dict[str, object] = {"timeout": timeout}
        if offset is not None:
            payload["offset"] = offset
        async with httpx.AsyncClient(timeout=timeout + 5) as client:
            resp = await client.post(url, json=payload)
        if resp.status_code != 200:
            try:
                data = resp.json() or {}
                _last_updates_error = str(data.get("description") or f"telegram_http_{resp.status_code}")
            except Exception:
                _last_updates_error = f"telegram_http_{resp.status_code}"
            return []
        data = resp.json() or {}
        _last_updates_error = None
        return list(data.get("result") or [])
    except Exception as exc:
        _last_updates_error = exc.__class__.__name__
        _log_telegram_failure("getUpdates", exc)
        return []


def get_updates_error() -> str | None:
    return _last_updates_error


def _local_time() -> str:
    return local_now().strftime("%H:%M")


async def get_system_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    try:
        async with AsyncSessionLocal() as db:
            res = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
            setting = res.scalar_one_or_none()
            return setting.value if setting else default
    except Exception:
        return default


async def get_currency_label(default: str = "ILS") -> str:
    value = await get_system_setting("store_currency", default)
    normalized = str(value or "").strip().upper()
    return normalized or default


async def alert_low_stock(product_name: str, barcode: str, stock: int, min_stock: int, *, store_id: str | None = None):
    msg = (
        f"⚠️ <b>تنبيه مخزون منخفض</b>\n\n"
        f"🏷️ المنتج: <b>{product_name}</b>\n"
        f"📊 باركود: <code>{barcode}</code>\n"
        f"📦 المخزون الحالي: <b>{stock}</b>\n"
        f"🔔 الحد الأدنى: {min_stock}\n"
        f"🕐 الوقت: {_local_time()}"
    )
    await send_alert(msg, store_id=store_id)


async def alert_out_of_stock(product_name: str, barcode: str, *, store_id: str | None = None):
    msg = (
        f"🚨 نفد المخزون!\n\n"
        f"🏷️ المنتج: <b>{product_name}</b>\n"
        f"📊 باركود: <code>{barcode}</code>\n"
        f"❌ المخزون: <b>0</b>\n"
        f"🕐 الوقت: {_local_time()}"
    )
    await send_alert(msg, store_id=store_id)


async def alert_large_invoice(invoice_id: int, total: float, cashier_name: str, *, store_id: str | None = None):
    threshold = float(os.getenv("ALERT_LARGE_INVOICE_AMOUNT", "500"))
    if total < threshold:
        return
    currency_label = await get_currency_label()
    msg = (
        f"💰 <b>فاتورة بمبلغ كبير</b>\n\n"
        f"🧾 رقم الفاتورة: <b>#{invoice_id}</b>\n"
        f"💵 الإجمالي: <b>{total:.2f} {currency_label}</b>\n"
        f"👤 الكاشير: {cashier_name}\n"
        f"🕐 الوقت: {_local_time()}"
    )
    await send_alert(msg, store_id=store_id)


async def alert_daily_summary(total_sales: float, invoice_count: int, date_str: str, *, store_id: str | None = None):
    currency_label = await get_currency_label()
    msg = (
        f"📊 <b>ملخص المبيعات اليومي</b>\n\n"
        f"📅 التاريخ: <b>{date_str}</b>\n"
        f"🧾 عدد الفواتير: <b>{invoice_count}</b>\n"
        f"💰 إجمالي المبيعات: <b>{total_sales:.2f} {currency_label}</b>"
    )
    await send_alert(msg, store_id=store_id)


async def alert_invoice_details(
    invoice_id: int,
    total: float,
    cashier_name: str,
    items_summary: str,
    customer_name: Optional[str] = None,
    store_id: str | None = None,
):
    currency_label = await get_currency_label()
    msg = (
        f"📄 <b>فاتورة جديدة</b>\n\n"
        f"🧾 رقم: <b>#{invoice_id}</b>\n"
        f"👤 العميل: {customer_name or '—'}\n"
        f"💵 الإجمالي: <b>{total:.2f} {currency_label}</b>\n"
        f"👷 الكاشير: {cashier_name}\n\n"
        f"🛒 <b>الأصناف:</b>\n{items_summary}\n"
        f"🕐 الوقت: {_local_time()}"
    )
    await send_alert(msg, store_id=store_id)
