from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import Customer, Session as CashierSession, StoreProfile
from services.launcher_service import activate_store_telegram_link
from services.timezone_service import utc_now
import telegram_alerts

ACTIVATION_EXPIRY_MINUTES = 10

STATUS_LABELS = {
    "inactive": "غير مفعل على تيليجرام",
    "pending": "بانتظار تأكيد العميل",
    "activated": "تم تفعيل تيليجرام",
    "failed": "فشل التفعيل",
    "expired": "انتهت صلاحية الطلب",
}


def normalize_phone_number(value: str | None) -> str:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if len(digits) < 7 or len(digits) > 15:
        raise HTTPException(400, "رقم الهاتف غير صالح")
    return digits


def activation_status_label(status: str | None) -> str:
    return STATUS_LABELS.get(status or "inactive", STATUS_LABELS["inactive"])


def _is_expired(customer: Customer) -> bool:
    if customer.telegram_activation_status != "pending":
        return False
    if not customer.activation_token_expiry:
        return False
    return customer.activation_token_expiry <= utc_now()


def ensure_customer_status_fresh(customer: Customer) -> Customer:
    if _is_expired(customer):
        customer.telegram_activation_status = "expired"
        customer.last_activation_token = None
        customer.activation_error_message = "انتهت صلاحية طلب التفعيل"
    return customer


def serialize_customer_status(customer: Customer | None, activation_url: str | None = None) -> dict[str, Any]:
    if not customer:
        return {
            "id": None,
            "customer_name": None,
            "phone_number": None,
            "telegram_chat_id": None,
            "telegram_activation_status": "inactive",
            "telegram_status_label": activation_status_label("inactive"),
            "telegram_activated_at": None,
            "activation_token_expiry": None,
            "activation_url": None,
            "activation_token": None,
        }

    ensure_customer_status_fresh(customer)
    return {
        "id": customer.id,
        "customer_name": customer.customer_name,
        "phone_number": customer.phone_number,
        # Keep raw chat IDs and bearer activation tokens server-side only.
        "telegram_chat_id": None,
        "telegram_activation_status": customer.telegram_activation_status or "inactive",
        "telegram_status_label": activation_status_label(customer.telegram_activation_status),
        "telegram_activated_at": customer.telegram_activated_at.isoformat() if customer.telegram_activated_at else None,
        "activation_token_expiry": customer.activation_token_expiry.isoformat() if customer.activation_token_expiry else None,
        "activation_url": activation_url,
        "activation_token": None,
    }


async def get_customer_by_phone(db: AsyncSession, phone_number: str) -> Customer | None:
    normalized = normalize_phone_number(phone_number)
    customer = (
        await db.execute(select(Customer).where(Customer.phone_number == normalized))
    ).scalar_one_or_none()
    if customer:
        ensure_customer_status_fresh(customer)
    return customer


async def search_customers(db: AsyncSession, query: str, limit: int = 8) -> list[Customer]:
    search_value = str(query or "").strip()
    if not search_value:
        return []

    normalized_phone = "".join(ch for ch in search_value if ch.isdigit())
    conditions = [Customer.customer_name.ilike(f"%{search_value}%")]
    if normalized_phone:
        conditions.append(Customer.phone_number.ilike(f"%{normalized_phone}%"))

    rows = (
        await db.execute(
            select(Customer)
            .where(or_(*conditions))
            .order_by(Customer.updated_at.desc(), Customer.customer_name.asc())
            .limit(max(1, min(int(limit or 8), 12)))
        )
    ).scalars().all()

    for customer in rows:
        ensure_customer_status_fresh(customer)
    return rows


async def list_customers(db: AsyncSession) -> list[Customer]:
    rows = (
        await db.execute(
            select(Customer)
            .order_by(Customer.updated_at.desc(), Customer.customer_name.asc(), Customer.id.desc())
        )
    ).scalars().all()

    for customer in rows:
        ensure_customer_status_fresh(customer)
    return rows


async def get_or_create_customer(
    db: AsyncSession,
    *,
    customer_name: str | None,
    phone_number: str,
) -> Customer:
    normalized_phone = normalize_phone_number(phone_number)
    customer = (
        await db.execute(select(Customer).where(Customer.phone_number == normalized_phone))
    ).scalar_one_or_none()
    clean_name = (customer_name or "").strip() or None

    if customer:
        ensure_customer_status_fresh(customer)
        if clean_name:
            customer.customer_name = clean_name[:120]
        return customer

    customer = Customer(
        customer_name=clean_name[:120] if clean_name else None,
        phone_number=normalized_phone,
        telegram_activation_status="inactive",
    )
    db.add(customer)
    await db.flush()
    return customer


async def ensure_session_token_owned_by_user(db: AsyncSession, *, user_id: int, session_token: str) -> CashierSession:
    session = (
        await db.execute(
            select(CashierSession).where(
                CashierSession.user_id == user_id,
                CashierSession.session_token == session_token,
                CashierSession.is_active == True,
            )
        )
    ).scalar_one_or_none()
    if not session:
        raise HTTPException(404, "جلسة الكاشير غير موجودة أو غير نشطة")
    return session


async def build_activation_url(token: str) -> str:
    bot_username = await telegram_alerts.get_bot_username()
    if not bot_username:
        raise HTTPException(503, "اسم مستخدم البوت غير متوفر. تحقق من إعدادات تيليجرام")
    return f"https://t.me/{bot_username}?start={token}"


async def create_activation_request(
    db: AsyncSession,
    *,
    user_id: int,
    customer_name: str | None,
    phone_number: str,
    session_token: str,
) -> dict[str, Any]:
    await ensure_session_token_owned_by_user(db, user_id=user_id, session_token=session_token)
    customer = await get_or_create_customer(db, customer_name=customer_name, phone_number=phone_number)

    if customer.telegram_chat_id and customer.telegram_activation_status == "activated":
        await db.commit()
        return serialize_customer_status(customer)

    token = secrets.token_urlsafe(24)
    expiry = utc_now() + timedelta(minutes=ACTIVATION_EXPIRY_MINUTES)
    customer.telegram_activation_status = "pending"
    customer.last_activation_token = token
    customer.activation_token_expiry = expiry
    customer.last_activation_requested_at = utc_now()
    customer.pending_cashier_user_id = user_id
    customer.pending_session_token = session_token
    customer.activation_error_message = None
    activation_url = await build_activation_url(token)
    await db.commit()
    await db.refresh(customer)
    return serialize_customer_status(customer, activation_url=activation_url)


async def process_telegram_start_token(db: AsyncSession, *, token: str, chat_id: str, telegram_username: str | None = None) -> dict[str, Any] | None:
    token = str(token or "").strip()
    if not token:
        return None
    from services.admin_recovery_service import process_manager_telegram_start_token

    if await process_manager_telegram_start_token(db, token=token, chat_id=chat_id, telegram_username=telegram_username):
        await telegram_alerts.send_message_to_chat(
            chat_id,
            "تم ربط تلجرام المدير بنجاح. سيتم استخدام هذا الحساب فقط لاستعادة حساب المدير والتنبيهات الإدارية.",
        )
        return None

    customer = (
        await db.execute(select(Customer).where(Customer.last_activation_token == token))
    ).scalar_one_or_none()
    if not customer:
        store_profile = (
            await db.execute(select(StoreProfile).where(StoreProfile.store_id == token))
        ).scalar_one_or_none()
        if store_profile:
            await activate_store_telegram_link(
                db,
                store=store_profile,
                chat_id=chat_id,
                telegram_username=telegram_username,
            )
            await telegram_alerts.send_message_to_chat(
                chat_id,
                "\n".join(
                    [
                        f"أهلًا بك في {store_profile.store_name}.",
                        "هذا البوت مخصص لاستلام الفواتير من المتجر عبر تيليجرام.",
                        "لتفعيل عميل محدد، اطلب من الكاشير إدخال رقم الهاتف ثم الضغط على تفعيل تيليجرام من داخل النظام.",
                    ]
                ),
            )
            return None

        await telegram_alerts.send_message_to_chat(chat_id, "تعذر تفعيل الاستلام. الرمز غير صالح أو تم استخدامه سابقًا.")
        return None

    ensure_customer_status_fresh(customer)
    if customer.telegram_activation_status == "expired":
        await db.commit()
        await telegram_alerts.send_message_to_chat(chat_id, "انتهت صلاحية طلب التفعيل. اطلب من الكاشير إنشاء طلب جديد.")
        return {
            "user_id": customer.pending_cashier_user_id,
            "session_token": customer.pending_session_token,
            "payload": serialize_customer_status(customer),
        }

    customer.telegram_chat_id = str(chat_id)
    customer.telegram_username = telegram_username
    customer.telegram_activation_status = "activated"
    customer.telegram_activated_at = utc_now()
    customer.activation_error_message = None
    customer.last_activation_token = None
    customer.activation_token_expiry = None
    await db.commit()
    await db.refresh(customer)

    await telegram_alerts.send_message_to_chat(
        chat_id,
        "تم تفعيل استلام الفاتورة عبر تيليجرام بنجاح. يمكنك الآن استلام الفاتورة PDF من الكاشير.",
    )

    return {
        "user_id": customer.pending_cashier_user_id,
        "session_token": customer.pending_session_token,
        "payload": serialize_customer_status(customer),
    }
