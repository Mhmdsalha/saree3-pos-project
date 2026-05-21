from __future__ import annotations

import json
import re
import secrets
from datetime import timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_password_hash, verify_password
from models import Session, StoreProfile, SystemSetting, User
from services.system_settings_service import get_system_setting_value, upsert_system_setting
from services.timezone_service import utc_now
import telegram_alerts


MANAGER_TELEGRAM_CHAT_ID_KEY = "manager_telegram_chat_id"
MANAGER_TELEGRAM_USERNAME_KEY = "manager_telegram_username"
MANAGER_TELEGRAM_VERIFIED_AT_KEY = "manager_telegram_verified_at"
TELEGRAM_RECOVERY_ENABLED_KEY = "telegram_recovery_enabled"
RECOVERY_SECRET_QUESTION_KEY = "admin_recovery_secret_question"
RECOVERY_SECRET_ANSWER_HASH_KEY = "admin_recovery_secret_answer_hash"
RECOVERY_CONFIGURED_KEY = "admin_recovery_configured"
RECOVERY_UPDATED_AT_KEY = "admin_recovery_updated_at"
SETUP_MANAGER_LINK_TOKEN_KEY = "admin_recovery_setup_telegram_token"
SETUP_MANAGER_LINK_CREATED_AT_KEY = "admin_recovery_setup_telegram_token_created_at"
RECOVERY_OTP_KEY = "admin_recovery_otp_state"
RECOVERY_SESSION_KEY = "admin_recovery_session_state"
RECOVERY_LOCK_UNTIL_KEY = "admin_recovery_lock_until"
RECOVERY_AUDIT_KEY = "admin_recovery_audit_log"

OTP_TTL_MINUTES = 10
OTP_MAX_ATTEMPTS = 5
SECRET_MAX_ATTEMPTS = 5
SECRET_SESSION_TTL_MINUTES = 10
RESEND_COOLDOWN_SECONDS = 60
LOCK_MINUTES = 15
MANAGER_SETUP_LINK_TTL_MINUTES = 30


def normalize_secret_answer(value: str) -> str:
    normalized = re.sub(r"\s+", " ", str(value or "").strip())
    return normalized.casefold()


def _mask_telegram(username: str | None, chat_id: str | None) -> str | None:
    clean_username = str(username or "").strip().lstrip("@")
    if clean_username:
        return f"@{clean_username}"
    clean_chat = str(chat_id or "").strip()
    if not clean_chat:
        return None
    return f"***{clean_chat[-4:]}"


def _json_load(raw: str | None, default: Any) -> Any:
    try:
        return json.loads(raw or "")
    except Exception:
        return default


async def _get_setting(db: AsyncSession, key: str, default: str = "") -> str:
    return str(await get_system_setting_value(db, key, default) or "")


async def _set_setting(db: AsyncSession, key: str, value: str, description: str = "") -> None:
    await upsert_system_setting(db, key=key, value=value, description=description)


async def _get_store(db: AsyncSession) -> StoreProfile | None:
    return (await db.execute(select(StoreProfile).order_by(StoreProfile.id.asc()))).scalar_one_or_none()


async def _get_admin(db: AsyncSession) -> User | None:
    return (
        await db.execute(
            select(User)
            .where(User.role == "admin", User.is_active == True)
            .order_by(User.id.asc())
        )
    ).scalar_one_or_none()


async def audit_recovery_event(
    db: AsyncSession,
    *,
    action: str,
    result: str,
    store_id: str | None = None,
    installation_id: str | None = None,
    admin_user_id: int | None = None,
) -> None:
    raw = await _get_setting(db, RECOVERY_AUDIT_KEY, "[]")
    entries = _json_load(raw, [])
    if not isinstance(entries, list):
        entries = []
    entries.append(
        {
            "action": action,
            "timestamp": utc_now().isoformat(),
            "store_id": store_id,
            "installation_id": installation_id,
            "result": result,
            "admin_user_id": admin_user_id,
        }
    )
    await _set_setting(db, RECOVERY_AUDIT_KEY, json.dumps(entries[-100:], ensure_ascii=False), "Admin recovery audit log")


async def ensure_manager_telegram_setup_link(db: AsyncSession) -> dict[str, Any]:
    if await _get_setting(db, MANAGER_TELEGRAM_CHAT_ID_KEY):
        return await get_manager_telegram_setup_status(db)

    token = await _get_setting(db, SETUP_MANAGER_LINK_TOKEN_KEY)
    if not token:
        token = f"mgr-{secrets.token_urlsafe(24)}"
        await _set_setting(db, SETUP_MANAGER_LINK_TOKEN_KEY, token, "Temporary manager Telegram setup token")
        await _set_setting(db, SETUP_MANAGER_LINK_CREATED_AT_KEY, utc_now().isoformat(), "Manager Telegram setup token creation time")
        await db.commit()
    return await get_manager_telegram_setup_status(db)


async def get_manager_telegram_setup_status(db: AsyncSession) -> dict[str, Any]:
    token = await _get_setting(db, SETUP_MANAGER_LINK_TOKEN_KEY)
    chat_id = await _get_setting(db, MANAGER_TELEGRAM_CHAT_ID_KEY)
    username = await _get_setting(db, MANAGER_TELEGRAM_USERNAME_KEY)
    verified_at = await _get_setting(db, MANAGER_TELEGRAM_VERIFIED_AT_KEY)
    bot_username = await telegram_alerts.get_bot_username()
    bot_token_configured = telegram_alerts.is_bot_token_configured()
    link = f"https://t.me/{bot_username}?start={token}" if bot_username and token else None
    return {
        "bot_username": bot_username,
        "bot_token_configured": bot_token_configured,
        "telegram_setup_problem": None if bot_token_configured else "missing_bot_token",
        "link": link,
        "linked": bool(chat_id),
        "manager_telegram_masked": _mask_telegram(username, chat_id),
        "manager_telegram_username": username or None,
        "verified_at": verified_at or None,
    }


async def process_manager_telegram_start_token(
    db: AsyncSession,
    *,
    token: str,
    chat_id: str,
    telegram_username: str | None = None,
) -> bool:
    expected = await _get_setting(db, SETUP_MANAGER_LINK_TOKEN_KEY)
    if not expected or not secrets.compare_digest(str(token or ""), expected):
        return False
    created_at = datetime_from_iso(await _get_setting(db, SETUP_MANAGER_LINK_CREATED_AT_KEY))
    if created_at and utc_now() - created_at > timedelta(minutes=MANAGER_SETUP_LINK_TTL_MINUTES):
        await _set_setting(db, SETUP_MANAGER_LINK_TOKEN_KEY, "", "Expired manager Telegram setup token")
        await _set_setting(db, SETUP_MANAGER_LINK_CREATED_AT_KEY, "", "Expired manager Telegram setup token creation time")
        await db.commit()
        return False

    now = utc_now().isoformat()
    await _set_setting(db, MANAGER_TELEGRAM_CHAT_ID_KEY, str(chat_id or "").strip(), "Manager Telegram chat id for admin recovery")
    await _set_setting(db, MANAGER_TELEGRAM_USERNAME_KEY, str(telegram_username or "").strip(), "Manager Telegram username for admin recovery")
    await _set_setting(db, MANAGER_TELEGRAM_VERIFIED_AT_KEY, now, "Manager Telegram verification time")
    await _set_setting(db, TELEGRAM_RECOVERY_ENABLED_KEY, "true", "Telegram OTP enabled for admin recovery")
    await _set_setting(db, SETUP_MANAGER_LINK_TOKEN_KEY, "", "Consumed manager Telegram setup token")
    await _set_setting(db, SETUP_MANAGER_LINK_CREATED_AT_KEY, "", "Consumed manager Telegram setup token creation time")
    await db.commit()
    return True


async def save_initial_recovery_config(db: AsyncSession, *, secret_question: str, secret_answer: str) -> None:
    question = str(secret_question or "").strip()
    answer = normalize_secret_answer(secret_answer)
    if not question:
        raise HTTPException(400, "سؤال استعادة الحساب مطلوب")
    if not answer:
        raise HTTPException(400, "إجابة الاستعادة مطلوبة")
    chat_id = await _get_setting(db, MANAGER_TELEGRAM_CHAT_ID_KEY)
    if not chat_id:
        raise HTTPException(400, "يجب ربط تلجرام المدير قبل إكمال الإعداد")

    now = utc_now().isoformat()
    await _set_setting(db, RECOVERY_SECRET_QUESTION_KEY, question, "Admin recovery secret question")
    await _set_setting(db, RECOVERY_SECRET_ANSWER_HASH_KEY, get_password_hash(answer), "Hashed admin recovery secret answer")
    await _set_setting(db, RECOVERY_CONFIGURED_KEY, "true", "Admin recovery configured")
    await _set_setting(db, RECOVERY_UPDATED_AT_KEY, now, "Admin recovery updated at")
    await _set_setting(db, TELEGRAM_RECOVERY_ENABLED_KEY, "true", "Telegram recovery enabled")
    await _set_setting(db, SETUP_MANAGER_LINK_TOKEN_KEY, "", "Consumed manager Telegram setup token")


async def get_recovery_status(db: AsyncSession, installation_id: str | None = None) -> dict[str, Any]:
    store = await _get_store(db)
    admin = await _get_admin(db)
    chat_id = await _get_setting(db, MANAGER_TELEGRAM_CHAT_ID_KEY)
    username = await _get_setting(db, MANAGER_TELEGRAM_USERNAME_KEY)
    question = await _get_setting(db, RECOVERY_SECRET_QUESTION_KEY)
    configured = (await _get_setting(db, RECOVERY_CONFIGURED_KEY)).lower() == "true"
    enabled = (await _get_setting(db, TELEGRAM_RECOVERY_ENABLED_KEY)).lower() == "true"
    return {
        "available": bool(store and admin and chat_id and question and configured and enabled),
        "host_only": True,
        "has_admin": bool(admin),
        "manager_telegram_linked": bool(chat_id),
        "manager_telegram_masked": _mask_telegram(username, chat_id),
        "secret_question_configured": bool(question and configured),
        "recovery_configured": bool(configured and enabled),
        "store_id": store.store_id if store else None,
        "installation_id": installation_id,
    }


async def request_recovery_otp(db: AsyncSession, *, installation_id: str | None = None) -> dict[str, Any]:
    status = await get_recovery_status(db, installation_id)
    if not status["available"]:
        raise HTTPException(400, "لم يتم إعداد طريقة استعادة حساب المدير بشكل صحيح.")

    now = utc_now()
    raw_lock = await _get_setting(db, RECOVERY_LOCK_UNTIL_KEY)
    if raw_lock:
        try:
            if datetime_from_iso(raw_lock) > now:
                raise HTTPException(429, "تم قفل الاستعادة مؤقتًا بسبب محاولات كثيرة")
        except HTTPException:
            raise
        except Exception:
            pass

    current_state = _json_load(await _get_setting(db, RECOVERY_OTP_KEY), {})
    requested_at = datetime_from_iso(current_state.get("requested_at")) if isinstance(current_state, dict) else None
    if requested_at and (now - requested_at).total_seconds() < RESEND_COOLDOWN_SECONDS:
        raise HTTPException(429, "انتظر قليلًا قبل إعادة إرسال رمز التحقق")

    otp = f"{secrets.randbelow(1_000_000):06d}"
    chat_id = await _get_setting(db, MANAGER_TELEGRAM_CHAT_ID_KEY)
    expires_at = now + timedelta(minutes=OTP_TTL_MINUTES)
    state = {
        "purpose": "admin_recovery",
        "otp_hash": get_password_hash(otp),
        "expires_at": expires_at.isoformat(),
        "requested_at": now.isoformat(),
        "attempts": 0,
        "used": False,
        "store_id": status.get("store_id"),
        "installation_id": installation_id,
        "manager_telegram_chat_id": chat_id,
    }
    message = (
        f"رمز استعادة حساب المدير في نظام سريع هو: {otp}\n\n"
        f"ينتهي الرمز خلال {OTP_TTL_MINUTES} دقائق.\n"
        "إذا لم تطلب ذلك، تجاهل هذه الرسالة."
    )
    sent = await telegram_alerts.send_message_to_chat(chat_id, message)
    if not sent:
        await audit_recovery_event(db, action="recovery_otp_requested", result="telegram_send_failed", store_id=status.get("store_id"), installation_id=installation_id)
        await db.commit()
        raise HTTPException(503, "تعذر إرسال رمز التحقق إلى تلجرام المدير")

    await _set_setting(db, RECOVERY_OTP_KEY, json.dumps(state, ensure_ascii=False), "Admin recovery OTP state")
    await _set_setting(db, RECOVERY_SESSION_KEY, "", "Admin recovery session state")
    await audit_recovery_event(db, action="recovery_otp_requested", result="success", store_id=status.get("store_id"), installation_id=installation_id)
    await db.commit()
    return {"ok": True, "expires_in_seconds": OTP_TTL_MINUTES * 60, "resend_cooldown_seconds": RESEND_COOLDOWN_SECONDS, "manager_telegram_masked": status.get("manager_telegram_masked")}


def datetime_from_iso(value: Any):
    from datetime import datetime

    raw = str(value or "").strip()
    if not raw:
        return None
    return datetime.fromisoformat(raw)


async def verify_recovery_otp(db: AsyncSession, *, otp: str, installation_id: str | None = None) -> dict[str, Any]:
    status = await get_recovery_status(db, installation_id)
    state = _json_load(await _get_setting(db, RECOVERY_OTP_KEY), {})
    if not isinstance(state, dict) or state.get("used"):
        raise HTTPException(400, "انتهت صلاحية رمز التحقق")
    if state.get("purpose") != "admin_recovery":
        raise HTTPException(400, "رمز التحقق غير صالح")
    expires_at = datetime_from_iso(state.get("expires_at"))
    if not expires_at or expires_at < utc_now():
        raise HTTPException(400, "انتهت صلاحية رمز التحقق")
    attempts = int(state.get("attempts") or 0)
    if attempts >= OTP_MAX_ATTEMPTS:
        await audit_recovery_event(db, action="recovery_otp_verify_failed", result="too_many_attempts", store_id=status.get("store_id"), installation_id=installation_id)
        await db.commit()
        raise HTTPException(429, "محاولات كثيرة. أعد إرسال رمز جديد.")
    clean_otp = re.sub(r"\D+", "", str(otp or ""))
    if not verify_password(clean_otp, str(state.get("otp_hash") or "")):
        state["attempts"] = attempts + 1
        await _set_setting(db, RECOVERY_OTP_KEY, json.dumps(state, ensure_ascii=False), "Admin recovery OTP state")
        await audit_recovery_event(db, action="recovery_otp_verify_failed", result="wrong_otp", store_id=status.get("store_id"), installation_id=installation_id)
        await db.commit()
        raise HTTPException(400, "رمز التحقق غير صحيح")

    token = secrets.token_urlsafe(32)
    session_state = {
        "token_hash": get_password_hash(token),
        "otp_verified_at": utc_now().isoformat(),
        "expires_at": (utc_now() + timedelta(minutes=SECRET_SESSION_TTL_MINUTES)).isoformat(),
        "secret_attempts": 0,
        "secret_verified": False,
        "store_id": status.get("store_id"),
        "installation_id": installation_id,
    }
    state["used"] = True
    await _set_setting(db, RECOVERY_OTP_KEY, json.dumps(state, ensure_ascii=False), "Admin recovery OTP state")
    await _set_setting(db, RECOVERY_SESSION_KEY, json.dumps(session_state, ensure_ascii=False), "Admin recovery session state")
    await audit_recovery_event(db, action="recovery_otp_verify_success", result="success", store_id=status.get("store_id"), installation_id=installation_id)
    await db.commit()
    question = await _get_setting(db, RECOVERY_SECRET_QUESTION_KEY)
    return {"ok": True, "recovery_token": token, "secret_question": question}


async def _load_valid_recovery_session(db: AsyncSession, token: str) -> dict[str, Any]:
    state = _json_load(await _get_setting(db, RECOVERY_SESSION_KEY), {})
    if not isinstance(state, dict) or not state.get("token_hash"):
        raise HTTPException(401, "جلسة الاستعادة غير صالحة")
    expires_at = datetime_from_iso(state.get("expires_at"))
    if not expires_at or expires_at < utc_now():
        raise HTTPException(401, "انتهت جلسة الاستعادة")
    if not verify_password(str(token or ""), str(state.get("token_hash") or "")):
        raise HTTPException(401, "جلسة الاستعادة غير صالحة")
    return state


async def verify_secret_answer(db: AsyncSession, *, recovery_token: str, answer: str, installation_id: str | None = None) -> dict[str, Any]:
    status = await get_recovery_status(db, installation_id)
    lock_until = datetime_from_iso(await _get_setting(db, RECOVERY_LOCK_UNTIL_KEY))
    if lock_until and lock_until > utc_now():
        raise HTTPException(429, "تم قفل الاستعادة مؤقتًا بسبب محاولات كثيرة")
    session_state = await _load_valid_recovery_session(db, recovery_token)
    attempts = int(session_state.get("secret_attempts") or 0)
    if attempts >= SECRET_MAX_ATTEMPTS:
        raise HTTPException(429, "تم قفل الاستعادة مؤقتًا بسبب محاولات كثيرة")
    answer_hash = await _get_setting(db, RECOVERY_SECRET_ANSWER_HASH_KEY)
    if not answer_hash or not verify_password(normalize_secret_answer(answer), answer_hash):
        attempts += 1
        session_state["secret_attempts"] = attempts
        if attempts >= SECRET_MAX_ATTEMPTS:
            await _set_setting(db, RECOVERY_LOCK_UNTIL_KEY, (utc_now() + timedelta(minutes=LOCK_MINUTES)).isoformat(), "Admin recovery lock until")
        await _set_setting(db, RECOVERY_SESSION_KEY, json.dumps(session_state, ensure_ascii=False), "Admin recovery session state")
        await audit_recovery_event(db, action="recovery_secret_answer_failed", result="wrong_answer", store_id=status.get("store_id"), installation_id=installation_id)
        await db.commit()
        raise HTTPException(400, "الإجابة غير صحيحة")

    admin = await _get_admin(db)
    if not admin:
        raise HTTPException(404, "حساب المدير غير موجود")
    session_state["secret_verified"] = True
    session_state["secret_verified_at"] = utc_now().isoformat()
    await _set_setting(db, RECOVERY_SESSION_KEY, json.dumps(session_state, ensure_ascii=False), "Admin recovery session state")
    await audit_recovery_event(db, action="recovery_secret_answer_success", result="success", store_id=status.get("store_id"), installation_id=installation_id, admin_user_id=admin.id)
    await db.commit()
    return {"ok": True, "admin_username": admin.username, "admin_user_id": admin.id}


async def reset_admin_credentials(
    db: AsyncSession,
    *,
    recovery_token: str,
    new_password: str,
    new_username: str | None = None,
    installation_id: str | None = None,
) -> dict[str, Any]:
    status = await get_recovery_status(db, installation_id)
    session_state = await _load_valid_recovery_session(db, recovery_token)
    if session_state.get("secret_verified") is not True:
        raise HTTPException(403, "يجب التحقق من تلجرام المدير وسؤال الاستعادة أولًا")
    if len(str(new_password or "")) < 8:
        raise HTTPException(400, "كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل")
    admin = await _get_admin(db)
    if not admin:
        raise HTTPException(404, "حساب المدير غير موجود")

    clean_username = str(new_username or "").strip()
    username_changed = False
    if clean_username and clean_username != admin.username:
        existing = (await db.execute(select(User).where(User.username == clean_username, User.id != admin.id))).scalar_one_or_none()
        if existing:
            raise HTTPException(400, "اسم المستخدم الجديد مستخدم مسبقًا")
        admin.username = clean_username
        username_changed = True

    admin.hashed_password = get_password_hash(new_password)
    await db.execute(update(Session).where(Session.user_id == admin.id).values(is_active=False, closed_at=utc_now(), disconnect_reason="admin_recovery_reset"))
    await _set_setting(db, RECOVERY_SESSION_KEY, "", "Consumed admin recovery session")
    await audit_recovery_event(db, action="admin_password_reset_via_recovery", result="success", store_id=status.get("store_id"), installation_id=installation_id, admin_user_id=admin.id)
    if username_changed:
        await audit_recovery_event(db, action="admin_username_changed_via_recovery", result="success", store_id=status.get("store_id"), installation_id=installation_id, admin_user_id=admin.id)
    await db.commit()
    return {"ok": True, "admin_username": admin.username}
