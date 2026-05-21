from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import secrets
import logging

from fastapi import HTTPException
from sqlalchemy import select, func as sqlfunc
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_password_hash
from models import Category, Invoice, Product, StoreProfile, SystemSetting, User
from services.license_service import (
    activate_license,
    build_activation_request_url,
    ensure_trial_initialized,
    evaluate_license_state,
)
from services.admin_recovery_service import (
    MANAGER_TELEGRAM_CHAT_ID_KEY,
    MANAGER_TELEGRAM_USERNAME_KEY,
    MANAGER_TELEGRAM_VERIFIED_AT_KEY,
    save_initial_recovery_config,
)
from services.system_branding import SYSTEM_BRAND_NAME
from services.system_settings_service import get_system_setting_value, upsert_system_setting
from services.timezone_service import utc_now
import telegram_alerts

logger = logging.getLogger(__name__)

STORE_TYPES = {"supermarket", "clothing", "pharmacy", "cosmetics"}

STORE_CATEGORY_SUGGESTIONS: dict[str, list[str]] = {
    "supermarket": [
        "مواد غذائية",
        "ألبان وأجبان",
        "مشروبات",
        "خضار وفواكه",
        "منظفات",
        "عناية شخصية",
    ],
    "clothing": [
        "رجالي",
        "نسائي",
        "أطفال",
        "أحذية",
        "إكسسوارات",
        "حقائب",
    ],
    "pharmacy": [
        "أدوية",
        "مكملات غذائية",
        "عناية بالبشرة",
        "أجهزة طبية",
        "أطفال",
        "مستلزمات شخصية",
    ],
    "cosmetics": [
        "عناية بالبشرة",
        "مكياج",
        "عطور",
        "عناية بالشعر",
        "أدوات تجميل",
        "إكسسوارات",
    ],
}

SERVER_PORT_KEY = "launcher_server_port"
SETUP_COMPLETED_KEY = "launcher_setup_completed"
STORE_NAME_KEY = "store_name"
STORE_CURRENCY_KEY = "store_currency"
STORE_LOGO_PATH_KEY = "store_logo_path"
TELEGRAM_ENABLED_KEY = "telegram_enabled"
TELEGRAM_AUTO_SEND_KEY = "telegram_auto_send"
TELEGRAM_MODE_KEY = "telegram_mode"
TELEGRAM_STORE_CHAT_ID_KEY = "telegram_store_chat_id"
TELEGRAM_STORE_USERNAME_KEY = "telegram_store_username"
TELEGRAM_STORE_LINKED_AT_KEY = "telegram_store_linked_at"


@dataclass
class SetupResult:
    store: StoreProfile
    server_port: int


def _scoped_store_setting_key(base_key: str, store_id: str | None) -> str:
    scoped_store_id = str(store_id or "").strip()
    return f"{base_key}:{scoped_store_id}" if scoped_store_id else base_key


async def _get_scoped_store_setting_value(
    db: AsyncSession,
    *,
    store_id: str | None,
    base_key: str,
    default: str,
    allow_legacy_fallback: bool = True,
) -> str:
    scoped_value = await get_system_setting_value(
        db,
        _scoped_store_setting_key(base_key, store_id),
        None,
    )
    if scoped_value is not None:
        return scoped_value
    if allow_legacy_fallback:
        legacy_value = await get_system_setting_value(db, base_key, None)
        if legacy_value is not None:
            return legacy_value
    return default


def build_store_id() -> str:
    return f"flowpos-{secrets.token_hex(6)}"


def _normalize_store_type(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in STORE_TYPES:
        raise HTTPException(400, "نوع المتجر غير مدعوم")
    return normalized


def supports_weighted_products(store_type: str | None) -> bool:
    return str(store_type or "").strip().lower() == "supermarket"


def _normalize_category_name(value: str) -> str:
    return " ".join(str(value or "").strip().split()).casefold()


async def _seed_categories_for_store_type(db: AsyncSession, store_type: str) -> bool:
    existing_names = {
        _normalize_category_name(name)
        for name in (await db.execute(select(Category.name))).scalars().all()
        if str(name or "").strip()
    }
    created = False

    for name in STORE_CATEGORY_SUGGESTIONS.get(store_type, []):
        clean_name = str(name or "").strip()
        normalized_name = _normalize_category_name(clean_name)
        if not clean_name or normalized_name in existing_names:
            continue
        db.add(Category(name=clean_name))
        existing_names.add(normalized_name)
        created = True
    return created


async def ensure_store_categories(db: AsyncSession) -> None:
    profile = await get_store_profile(db)
    if not profile:
        return
    created = await _seed_categories_for_store_type(db, profile.store_type)
    if created:
        await db.commit()


async def get_store_profile(db: AsyncSession) -> StoreProfile | None:
    return (await db.execute(select(StoreProfile).order_by(StoreProfile.id.asc()))).scalar_one_or_none()


async def get_store_branding(db: AsyncSession) -> dict[str, str | None]:
    profile = await get_store_profile(db)
    if not profile:
        return {
            "store_name": None,
            "currency": None,
            "logo_path": None,
            "phone": None,
            "address": None,
        }
    return {
        "store_name": profile.store_name,
        "currency": profile.currency,
        "logo_path": profile.logo_path,
        "phone": profile.phone,
        "address": profile.address,
    }


async def get_public_storefront(db: AsyncSession) -> dict[str, str | bool | None]:
    profile = await get_store_profile(db)
    setup_state = await get_setup_state(db, store=profile)
    if not profile or not setup_state["initialized"]:
        return {
            "initialized": False,
            "setup_state": setup_state["setup_state"],
            "setup_reason": setup_state["setup_reason"],
            "store_name": SYSTEM_BRAND_NAME,
            "country": None,
            "currency": None,
            "store_type": None,
            "logo_path": None,
            "logo_url": None,
            "phone": None,
            "address": None,
            "branding_revision": None,
        }
    branding_revision = profile.updated_at.isoformat() if profile.updated_at else None
    return {
        "initialized": True,
        "setup_state": setup_state["setup_state"],
        "setup_reason": setup_state["setup_reason"],
        "store_name": profile.store_name,
        "country": profile.country,
        "currency": profile.currency,
        "store_type": profile.store_type,
        "logo_path": profile.logo_path,
        "logo_url": f"/launcher/store-logo?v={branding_revision}" if profile.logo_path else None,
        "phone": profile.phone,
        "address": profile.address,
        "branding_revision": branding_revision,
    }


async def is_initialized(db: AsyncSession) -> bool:
    setup_state = await get_setup_state(db)
    return bool(setup_state["initialized"])


async def has_admin_user(db: AsyncSession) -> bool:
    count = await db.scalar(select(sqlfunc.count(User.id)).where(User.role == "admin", User.is_active == True))
    return bool(count)


async def get_setup_state(db: AsyncSession, *, store: StoreProfile | None = None) -> dict[str, Any]:
    profile = store if store is not None else await get_store_profile(db)
    has_admin = await has_admin_user(db)
    setup_completed_raw = await get_system_setting_value(db, SETUP_COMPLETED_KEY, None)
    setup_completed = str(setup_completed_raw or "").strip().lower() in {"1", "true", "yes", "on"}

    if profile and has_admin and (setup_completed or setup_completed_raw is None):
        state = "complete"
        reason = "complete" if setup_completed else "legacy_complete"
        initialized = True
    elif not profile and not has_admin:
        state = "fresh"
        reason = "empty_database"
        initialized = False
    else:
        state = "incomplete"
        if profile and not has_admin:
            reason = "store_without_admin"
        elif has_admin and not profile:
            reason = "admin_without_store"
        else:
            reason = "setup_completion_flag_missing_or_false"
        initialized = False

    logger.info(
        "launcher setup detection: initialized=%s state=%s reason=%s has_store=%s has_admin=%s setup_flag=%s",
        initialized,
        state,
        reason,
        bool(profile),
        has_admin,
        setup_completed_raw,
    )
    return {
        "initialized": initialized,
        "setup_state": state,
        "setup_reason": reason,
        "has_store": bool(profile),
        "has_admin": has_admin,
        "setup_completed": setup_completed,
        "store": profile,
    }


async def _legacy_assert_launcher_setup_allowed(db: AsyncSession) -> None:
    if await is_initialized(db):
        raise HTTPException(409, "تم تهيئة النظام مسبقًا")

    user_count = await db.scalar(select(sqlfunc.count(User.id)))
    product_count = await db.scalar(select(sqlfunc.count(Product.id)))
    invoice_count = await db.scalar(select(sqlfunc.count(Invoice.id)))

    if any(int(value or 0) > 0 for value in (user_count, product_count, invoice_count)):
        raise HTTPException(409, "لا يمكن تشغيل الإعداد الأول لأن قاعدة البيانات ليست فارغة")


async def assert_launcher_setup_allowed(db: AsyncSession) -> None:
    setup_state = await get_setup_state(db)
    if setup_state["initialized"]:
        raise HTTPException(409, "System setup has already been completed.")

    store_count = await db.scalar(select(sqlfunc.count(StoreProfile.id)))
    user_count = await db.scalar(select(sqlfunc.count(User.id)))
    product_count = await db.scalar(select(sqlfunc.count(Product.id)))
    invoice_count = await db.scalar(select(sqlfunc.count(Invoice.id)))

    if any(int(value or 0) > 0 for value in (store_count, user_count, product_count, invoice_count)):
        raise HTTPException(
            409,
            "Incomplete setup or existing local data was detected. Repair the setup or start from an empty database.",
        )


async def setup_store(
    db: AsyncSession,
    *,
    store_name: str,
    country: str,
    currency: str,
    store_type: str,
    phone: str | None,
    address: str | None,
    logo_path: str | None,
    server_port: int | None,
    admin_name: str,
    admin_username: str,
    admin_password: str,
    secret_question: str,
    secret_answer: str,
) -> SetupResult:
    await assert_launcher_setup_allowed(db)

    existing_username = (await db.execute(select(User).where(User.username == admin_username.strip()))).scalar_one_or_none()
    if existing_username:
        raise HTTPException(400, "اسم مستخدم المدير موجود مسبقًا")

    normalized_store_type = _normalize_store_type(store_type)

    profile = StoreProfile(
        store_id=build_store_id(),
        store_name=store_name.strip(),
        country=country.strip(),
        currency=currency.strip().upper(),
        store_type=normalized_store_type,
        phone=(phone or "").strip() or None,
        address=(address or "").strip() or None,
        logo_path=(logo_path or "").strip() or None,
        initialized_at=utc_now(),
    )
    db.add(profile)
    await _seed_categories_for_store_type(db, normalized_store_type)

    admin = User(
        name=admin_name.strip(),
        username=admin_username.strip(),
        hashed_password=get_password_hash(admin_password),
        role="admin",
        is_active=True,
    )
    db.add(admin)

    if server_port is not None:
        await upsert_system_setting(
            db,
            key=SERVER_PORT_KEY,
            value=str(int(server_port)),
            description=f"منفذ السيرفر المحلي المعتمد من {SYSTEM_BRAND_NAME}",
        )
    await upsert_system_setting(
        db,
        key=STORE_NAME_KEY,
        value=profile.store_name,
        description="اسم المتجر للعرض في الواجهات والفواتير",
    )
    await upsert_system_setting(
        db,
        key=STORE_CURRENCY_KEY,
        value=profile.currency,
        description="العملة الافتراضية للمتجر",
    )
    await upsert_system_setting(
        db,
        key=STORE_LOGO_PATH_KEY,
        value=profile.logo_path or "",
        description="مسار شعار المتجر",
    )

    await upsert_system_setting(
        db,
        key=_scoped_store_setting_key(TELEGRAM_ENABLED_KEY, profile.store_id),
        value="false",
        description="تفعيل تكامل تيليجرام المركزي من اللانشر",
    )
    await upsert_system_setting(
        db,
        key=_scoped_store_setting_key(TELEGRAM_AUTO_SEND_KEY, profile.store_id),
        value="false",
        description="الإرسال التلقائي للفواتير عبر تيليجرام",
    )
    await upsert_system_setting(
        db,
        key=_scoped_store_setting_key(TELEGRAM_MODE_KEY, profile.store_id),
        value="pdf",
        description="نمط الإرسال عبر تيليجرام: pdf أو text",
    )

    manager_chat_id = str(await get_system_setting_value(db, MANAGER_TELEGRAM_CHAT_ID_KEY, "") or "").strip()
    manager_username = str(await get_system_setting_value(db, MANAGER_TELEGRAM_USERNAME_KEY, "") or "").strip()
    manager_verified_at = str(await get_system_setting_value(db, MANAGER_TELEGRAM_VERIFIED_AT_KEY, "") or "").strip()
    if manager_chat_id:
        await upsert_system_setting(
            db,
            key=_scoped_store_setting_key(TELEGRAM_STORE_CHAT_ID_KEY, profile.store_id),
            value=manager_chat_id,
            description="Store-scoped manager Telegram chat id for administrative alerts",
        )
        await upsert_system_setting(
            db,
            key=_scoped_store_setting_key(TELEGRAM_STORE_USERNAME_KEY, profile.store_id),
            value=manager_username,
            description="Store-scoped manager Telegram username for administrative alerts",
        )
        await upsert_system_setting(
            db,
            key=_scoped_store_setting_key(TELEGRAM_STORE_LINKED_AT_KEY, profile.store_id),
            value=manager_verified_at or utc_now().isoformat(),
            description="Store-scoped manager Telegram link time",
        )

    await save_initial_recovery_config(
        db,
        secret_question=secret_question,
        secret_answer=secret_answer,
    )
    await upsert_system_setting(
        db,
        key=SETUP_COMPLETED_KEY,
        value="true",
        description=f"First-time setup completion flag for {SYSTEM_BRAND_NAME}",
    )

    await db.commit()
    await db.refresh(profile)
    ensure_trial_initialized(profile.store_id)
    return SetupResult(store=profile, server_port=int(server_port or 8000))


async def update_store_profile(
    db: AsyncSession,
    *,
    store_name: str | None = None,
    country: str | None = None,
    currency: str | None = None,
    store_type: str | None = None,
    phone: str | None = None,
    address: str | None = None,
    logo_path: str | None = None,
) -> StoreProfile:
    profile = await get_store_profile(db)
    if not profile:
        raise HTTPException(404, "لم تتم تهيئة بيانات المتجر بعد")

    store_type_changed = False
    if store_name is not None:
        profile.store_name = store_name.strip()
    if country is not None:
        profile.country = country.strip()
    if currency is not None:
        profile.currency = currency.strip().upper()
    if store_type is not None:
        normalized_store_type = _normalize_store_type(store_type)
        store_type_changed = normalized_store_type != profile.store_type
        profile.store_type = normalized_store_type
    if phone is not None:
        profile.phone = phone.strip() or None
    if address is not None:
        profile.address = address.strip() or None
    if logo_path is not None:
        profile.logo_path = logo_path.strip() or None

    profile.updated_at = utc_now()
    await upsert_system_setting(
        db,
        key=STORE_NAME_KEY,
        value=profile.store_name,
        description="اسم المتجر للعرض في الواجهات والفواتير",
    )
    await upsert_system_setting(
        db,
        key=STORE_CURRENCY_KEY,
        value=profile.currency,
        description="العملة الافتراضية للمتجر",
    )
    await upsert_system_setting(
        db,
        key=STORE_LOGO_PATH_KEY,
        value=profile.logo_path or "",
        description="مسار شعار المتجر",
    )
    if store_type_changed:
        await _seed_categories_for_store_type(db, profile.store_type)
    await db.commit()
    await db.refresh(profile)
    return profile


async def get_server_port(db: AsyncSession, default: int = 8000) -> int:
    raw = await get_system_setting_value(db, SERVER_PORT_KEY, str(default))
    try:
        port = int(str(raw or default))
        if port < 1 or port > 65535:
            raise ValueError
        return port
    except Exception:
        return default


async def get_launcher_status(db: AsyncSession, runtime: dict[str, Any]) -> dict[str, Any]:
    store = await get_store_profile(db)
    setup_state = await get_setup_state(db, store=store)
    license_status = evaluate_license_state(store.store_id) if store else evaluate_license_state()
    license_status["activation_request_url"] = build_activation_request_url(
        store_name=store.store_name if store else None,
        store_type=store.store_type if store else None,
        country=store.country if store else None,
        currency=store.currency if store else None,
        store_id=store.store_id if store else None,
        license_status=license_status.get("license_status"),
    )
    return {
        "initialized": setup_state["initialized"],
        "setup_state": setup_state["setup_state"],
        "setup_reason": setup_state["setup_reason"],
        "has_admin": setup_state["has_admin"],
        "server_port": await get_server_port(db),
        "runtime": runtime,
        "store": store,
        "license": license_status,
    }


async def get_telegram_settings(db: AsyncSession) -> dict[str, Any]:
    profile = await get_store_profile(db)
    bot_username = await telegram_alerts.get_bot_username()
    store_id = profile.store_id if profile else None
    enabled = (
        await _get_scoped_store_setting_value(
            db,
            store_id=store_id,
            base_key=TELEGRAM_ENABLED_KEY,
            default="false",
        )
    ).lower() == "true"
    auto_send = (
        await _get_scoped_store_setting_value(
            db,
            store_id=store_id,
            base_key=TELEGRAM_AUTO_SEND_KEY,
            default="false",
        )
    ).lower() == "true"
    mode = (
        await _get_scoped_store_setting_value(
            db,
            store_id=store_id,
            base_key=TELEGRAM_MODE_KEY,
            default="pdf",
        )
        or "pdf"
    ).strip().lower()
    if mode not in {"pdf", "text"}:
        mode = "pdf"

    linked_chat_id = await _get_scoped_store_setting_value(
        db,
        store_id=store_id,
        base_key=TELEGRAM_STORE_CHAT_ID_KEY,
        default="",
        allow_legacy_fallback=False,
    )
    linked_username = await _get_scoped_store_setting_value(
        db,
        store_id=store_id,
        base_key=TELEGRAM_STORE_USERNAME_KEY,
        default="",
        allow_legacy_fallback=False,
    )
    linked_at = await _get_scoped_store_setting_value(
        db,
        store_id=store_id,
        base_key=TELEGRAM_STORE_LINKED_AT_KEY,
        default="",
        allow_legacy_fallback=False,
    )
    store_linked = bool(str(linked_chat_id or "").strip())

    link = None
    if profile and bot_username:
        link = f"https://t.me/{bot_username}?start={profile.store_id}"

    return {
        "telegram_enabled": enabled,
        "telegram_auto_send": auto_send,
        "telegram_mode": mode,
        "bot_username": bot_username,
        "bot_status": "active" if bot_username else "unconfigured",
        "link": link,
        "store_linked": store_linked,
        "store_linked_at": str(linked_at or "").strip() or None,
        "store_linked_username": str(linked_username or "").strip() or None,
    }


async def update_telegram_settings(
    db: AsyncSession,
    *,
    telegram_enabled: bool,
    telegram_auto_send: bool,
    telegram_mode: str,
) -> dict[str, Any]:
    profile = await get_store_profile(db)
    if not profile:
        raise HTTPException(404, "لم تتم تهيئة بيانات المتجر بعد")

    await upsert_system_setting(
        db,
        key=_scoped_store_setting_key(TELEGRAM_ENABLED_KEY, profile.store_id),
        value="true" if telegram_enabled else "false",
        description="تفعيل تيليجرام من اللانشر",
    )
    await upsert_system_setting(
        db,
        key=_scoped_store_setting_key(TELEGRAM_AUTO_SEND_KEY, profile.store_id),
        value="true" if telegram_auto_send else "false",
        description="الإرسال التلقائي للفواتير عبر تيليجرام",
    )
    await upsert_system_setting(
        db,
        key=_scoped_store_setting_key(TELEGRAM_MODE_KEY, profile.store_id),
        value=telegram_mode,
        description="نمط إرسال الفاتورة عبر تيليجرام",
    )
    await db.commit()
    return await get_telegram_settings(db)


async def activate_store_telegram_link(
    db: AsyncSession,
    *,
    store: StoreProfile,
    chat_id: str,
    telegram_username: str | None = None,
) -> None:
    await upsert_system_setting(
        db,
        key=_scoped_store_setting_key(TELEGRAM_ENABLED_KEY, store.store_id),
        value="true",
        description="ØªÙØ¹ÙŠÙ„ ØªÙƒØ§Ù…Ù„ ØªÙŠÙ„ÙŠØ¬Ø±Ø§Ù… Ø¨Ø¹Ø¯ Ø±Ø¨Ø· Ø§Ù„Ù…ØªØ¬Ø± Ù…Ø¹ Ø§Ù„Ø¨ÙˆØª",
    )
    await upsert_system_setting(
        db,
        key=_scoped_store_setting_key(TELEGRAM_STORE_CHAT_ID_KEY, store.store_id),
        value=str(chat_id or "").strip(),
        description="Ù…Ø¹Ø±Ù Ù…Ø­Ø§Ø¯Ø«Ø© ØªÙŠÙ„ÙŠØ¬Ø±Ø§Ù… Ø§Ù„Ù…Ø±ØªØ¨Ø·Ø© Ø¨Ø§Ù„Ù…ØªØ¬Ø±",
    )
    await upsert_system_setting(
        db,
        key=_scoped_store_setting_key(TELEGRAM_STORE_USERNAME_KEY, store.store_id),
        value=str(telegram_username or "").strip(),
        description="Ø§Ø³Ù… Ù…Ø³ØªØ®Ø¯Ù… ØªÙŠÙ„ÙŠØ¬Ø±Ø§Ù… Ø§Ù„Ø°ÙŠ Ø±Ø¨Ø· Ø§Ù„Ù…ØªØ¬Ø±",
    )
    await upsert_system_setting(
        db,
        key=_scoped_store_setting_key(TELEGRAM_STORE_LINKED_AT_KEY, store.store_id),
        value=utc_now().isoformat(),
        description="ÙˆÙ‚Øª Ø±Ø¨Ø· Ø§Ù„Ù…ØªØ¬Ø± Ù…Ø¹ Ø¨ÙˆØª ØªÙŠÙ„ÙŠØ¬Ø±Ø§Ù…",
    )
    await db.commit()


def get_category_suggestions(store_type: str) -> list[str]:
    return list(STORE_CATEGORY_SUGGESTIONS.get(_normalize_store_type(store_type), []))


async def get_launcher_license_status(db: AsyncSession) -> dict[str, Any]:
    profile = await get_store_profile(db)
    payload = evaluate_license_state(profile.store_id if profile else None)
    payload["activation_request_url"] = build_activation_request_url(
        store_name=profile.store_name if profile else None,
        store_type=profile.store_type if profile else None,
        country=profile.country if profile else None,
        currency=profile.currency if profile else None,
        store_id=profile.store_id if profile else None,
        license_status=payload.get("license_status"),
    )
    return payload


async def activate_launcher_license(db: AsyncSession, activation_key: str) -> dict[str, Any]:
    profile = await get_store_profile(db)
    if not profile:
        raise HTTPException(400, "يجب إكمال إعداد المتجر أولًا قبل التفعيل")
    payload = activate_license(profile.store_id, activation_key)
    payload["activation_request_url"] = build_activation_request_url(
        store_name=profile.store_name,
        store_type=profile.store_type,
        country=profile.country,
        currency=profile.currency,
        store_id=profile.store_id,
        license_status=payload.get("license_status"),
    )
    return payload
