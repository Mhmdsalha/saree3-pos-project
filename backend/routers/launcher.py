from __future__ import annotations

import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Customer
from schemas import (
    AdminRecoveryOtpRequestOut,
    AdminRecoveryOtpVerifyIn,
    AdminRecoveryOtpVerifyOut,
    AdminRecoveryResetIn,
    AdminRecoveryResetOut,
    AdminRecoverySecretVerifyIn,
    AdminRecoverySecretVerifyOut,
    AdminRecoveryStatusOut,
    LauncherStatusOut,
    LicenseActivationIn,
    LicenseStatusOut,
    ManagerTelegramSetupStatusOut,
    StoreProfileOut,
    StoreProfileSetup,
    StoreProfileUpdate,
    StorefrontOut,
    TelegramLauncherSettingsOut,
    TelegramLauncherSettingsUpdate,
)
from services.launcher_service import (
    activate_launcher_license,
    get_category_suggestions,
    get_launcher_license_status,
    get_launcher_status,
    get_public_storefront,
    get_server_port,
    get_store_profile,
    get_telegram_settings,
    setup_store,
    update_store_profile,
    update_telegram_settings,
)
from services.local_ssl_service import get_lan_ip
from services.admin_recovery_service import (
    ensure_manager_telegram_setup_link,
    get_manager_telegram_setup_status,
    get_recovery_status,
    request_recovery_otp,
    reset_admin_credentials,
    verify_recovery_otp,
    verify_secret_answer,
)
from services.system_branding import SYSTEM_BRAND_NAME
import telegram_alerts

router = APIRouter(prefix="/launcher", tags=["launcher"])


class TelegramLauncherTestPayload(BaseModel):
    customer_id: int


def _is_loopback(host: str | None) -> bool:
    normalized = str(host or "").strip().lower()
    return normalized in {"127.0.0.1", "::1", "localhost"}


async def require_launcher_access(
    request: Request,
    launcher_header: str | None = Header(default=None, alias="X-FlowPOS-Launcher"),
):
    host = request.client.host if request.client else None
    if not _is_loopback(host):
        raise HTTPException(403, "مسارات اللانشر متاحة محليًا فقط")
    if str(launcher_header or "").strip().lower() != "true":
        raise HTTPException(403, "طلب اللانشر غير مصرح")


def _runtime_payload() -> dict:
    base_dir = Path(__file__).resolve().parent.parent
    frontend_dist = base_dir.parent / "frontend" / "dist"
    database_url = os.getenv("DATABASE_URL", "")
    database_backend = "postgresql" if database_url.startswith(("postgres://", "postgresql://")) else "sqlite"
    return {
        "database_backend": database_backend,
        "app_timezone": os.getenv("APP_TIMEZONE", "Asia/Jerusalem"),
        "frontend_built": frontend_dist.exists(),
        "telegram_bot_configured": bool(os.getenv("TELEGRAM_BOT_TOKEN", "").strip()),
    }


def _mask_identifier(value: str | None) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    return f"***{text[-4:]}" if len(text) > 4 else "***"


@router.get("/status", response_model=LauncherStatusOut, dependencies=[Depends(require_launcher_access)])
async def launcher_status(db: AsyncSession = Depends(get_db)):
    return await get_launcher_status(db, _runtime_payload())


@router.get("/public-storefront", response_model=StorefrontOut)
async def launcher_public_storefront(db: AsyncSession = Depends(get_db)):
    return await get_public_storefront(db)


@router.get("/store-logo")
async def launcher_store_logo(db: AsyncSession = Depends(get_db)):
    profile = await get_store_profile(db)
    logo_path = str(profile.logo_path or "").strip() if profile else ""
    if not logo_path:
        raise HTTPException(404, "شعار المتجر غير متوفر")

    logo_file = Path(logo_path)
    if not logo_file.exists() or not logo_file.is_file():
        raise HTTPException(404, "ملف شعار المتجر غير موجود")

    extension = logo_file.suffix.lower()
    if extension not in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico"}:
        raise HTTPException(404, "صيغة شعار المتجر غير مدعومة")

    media_type, _ = mimetypes.guess_type(str(logo_file))
    return FileResponse(str(logo_file), media_type=media_type or "application/octet-stream")


@router.post("/setup", response_model=StoreProfileOut, dependencies=[Depends(require_launcher_access)])
async def launcher_setup(payload: StoreProfileSetup, db: AsyncSession = Depends(get_db)):
    result = await setup_store(
        db,
        store_name=payload.store_name,
        country=payload.country,
        currency=payload.currency,
        store_type=payload.store_type,
        phone=payload.phone,
        address=payload.address,
        logo_path=payload.logo_path,
        server_port=payload.server_port,
        admin_name=payload.admin_name,
        admin_username=payload.admin_username,
        admin_password=payload.admin_password,
        secret_question=payload.secret_question,
        secret_answer=payload.secret_answer,
    )
    return result.store


@router.post("/setup/manager-telegram-link", response_model=ManagerTelegramSetupStatusOut, dependencies=[Depends(require_launcher_access)])
async def launcher_setup_manager_telegram_link(db: AsyncSession = Depends(get_db)):
    return await ensure_manager_telegram_setup_link(db)


@router.get("/setup/manager-telegram-link", response_model=ManagerTelegramSetupStatusOut, dependencies=[Depends(require_launcher_access)])
async def launcher_setup_manager_telegram_status(db: AsyncSession = Depends(get_db)):
    return await get_manager_telegram_setup_status(db)


@router.get("/admin-recovery/status", response_model=AdminRecoveryStatusOut, dependencies=[Depends(require_launcher_access)])
async def launcher_admin_recovery_status(db: AsyncSession = Depends(get_db)):
    return await get_recovery_status(db, os.getenv("FLOWPOS_INSTALLATION_ID", ""))


@router.post("/admin-recovery/request-otp", response_model=AdminRecoveryOtpRequestOut, dependencies=[Depends(require_launcher_access)])
async def launcher_admin_recovery_request_otp(db: AsyncSession = Depends(get_db)):
    return await request_recovery_otp(db, installation_id=os.getenv("FLOWPOS_INSTALLATION_ID", ""))


@router.post("/admin-recovery/verify-otp", response_model=AdminRecoveryOtpVerifyOut, dependencies=[Depends(require_launcher_access)])
async def launcher_admin_recovery_verify_otp(payload: AdminRecoveryOtpVerifyIn, db: AsyncSession = Depends(get_db)):
    return await verify_recovery_otp(db, otp=payload.otp, installation_id=os.getenv("FLOWPOS_INSTALLATION_ID", ""))


@router.post("/admin-recovery/verify-secret", response_model=AdminRecoverySecretVerifyOut, dependencies=[Depends(require_launcher_access)])
async def launcher_admin_recovery_verify_secret(payload: AdminRecoverySecretVerifyIn, db: AsyncSession = Depends(get_db)):
    return await verify_secret_answer(db, recovery_token=payload.recovery_token, answer=payload.answer, installation_id=os.getenv("FLOWPOS_INSTALLATION_ID", ""))


@router.post("/admin-recovery/reset", response_model=AdminRecoveryResetOut, dependencies=[Depends(require_launcher_access)])
async def launcher_admin_recovery_reset(payload: AdminRecoveryResetIn, db: AsyncSession = Depends(get_db)):
    return await reset_admin_credentials(
        db,
        recovery_token=payload.recovery_token,
        new_password=payload.new_password,
        new_username=payload.new_username,
        installation_id=os.getenv("FLOWPOS_INSTALLATION_ID", ""),
    )


@router.get("/store-profile", response_model=StoreProfileOut, dependencies=[Depends(require_launcher_access)])
async def launcher_store_profile(db: AsyncSession = Depends(get_db)):
    profile = await get_store_profile(db)
    if not profile:
        raise HTTPException(404, "لم تتم تهيئة المتجر بعد")
    return profile


@router.get("/network-info", dependencies=[Depends(require_launcher_access)])
async def launcher_network_info(db: AsyncSession = Depends(get_db)):
    port = await get_server_port(db)
    lan_ip = get_lan_ip()
    return {
        "lan_ip": lan_ip,
        "desktop_url": f"https://{lan_ip}:{port}/frontend-react/",
        "mobile_url": f"https://{lan_ip}:{port}/mobile-react/",
    }


@router.put("/store-profile", response_model=StoreProfileOut, dependencies=[Depends(require_launcher_access)])
async def launcher_update_store_profile(payload: StoreProfileUpdate, db: AsyncSession = Depends(get_db)):
    return await update_store_profile(
        db,
        store_name=payload.store_name,
        country=payload.country,
        currency=payload.currency,
        store_type=payload.store_type,
        phone=payload.phone,
        address=payload.address,
        logo_path=payload.logo_path,
    )


@router.get("/telegram", response_model=TelegramLauncherSettingsOut, dependencies=[Depends(require_launcher_access)])
async def launcher_telegram_settings(db: AsyncSession = Depends(get_db)):
    return await get_telegram_settings(db)


@router.get("/license", response_model=LicenseStatusOut, dependencies=[Depends(require_launcher_access)])
async def launcher_license_status(db: AsyncSession = Depends(get_db)):
    return await get_launcher_license_status(db)


@router.post("/license/activate", response_model=LicenseStatusOut, dependencies=[Depends(require_launcher_access)])
async def launcher_activate_license(payload: LicenseActivationIn, db: AsyncSession = Depends(get_db)):
    return await activate_launcher_license(db, payload.activation_key)


@router.put("/telegram", response_model=TelegramLauncherSettingsOut, dependencies=[Depends(require_launcher_access)])
async def launcher_update_telegram_settings(payload: TelegramLauncherSettingsUpdate, db: AsyncSession = Depends(get_db)):
    return await update_telegram_settings(
        db,
        telegram_enabled=payload.telegram_enabled,
        telegram_auto_send=payload.telegram_auto_send,
        telegram_mode=payload.telegram_mode,
    )


@router.get("/customers", dependencies=[Depends(require_launcher_access)])
async def launcher_customers(db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(Customer).order_by(Customer.updated_at.desc(), Customer.customer_name.asc(), Customer.id.desc())
        )
    ).scalars().all()
    return [
        {
            "id": row.id,
            "customer_name": row.customer_name,
            "phone_number": row.phone_number,
            "telegram_chat_id": _mask_identifier(row.telegram_chat_id),
            "telegram_activation_status": row.telegram_activation_status,
        }
        for row in rows
    ]


@router.post("/telegram/test", dependencies=[Depends(require_launcher_access)])
async def launcher_send_telegram_test(payload: TelegramLauncherTestPayload, db: AsyncSession = Depends(get_db)):
    customer = (await db.execute(select(Customer).where(Customer.id == payload.customer_id))).scalar_one_or_none()
    if not customer:
        raise HTTPException(404, "العميل غير موجود")
    if not customer.telegram_chat_id or customer.telegram_activation_status != "activated":
        raise HTTPException(400, "هذا العميل غير مفعل على تيليجرام")

    sent = await telegram_alerts.send_message_to_chat(
        customer.telegram_chat_id,
        f"هذه رسالة اختبار من {SYSTEM_BRAND_NAME} للتأكد من جاهزية استلام الفواتير.",
    )
    if not sent:
        raise HTTPException(503, "تعذر إرسال الرسالة التجريبية عبر تيليجرام")
    return {"ok": True}


@router.get("/category-templates/{store_type}", dependencies=[Depends(require_launcher_access)])
async def launcher_category_templates(store_type: str):
    return {
        "store_type": store_type,
        "suggestions": get_category_suggestions(store_type),
    }
