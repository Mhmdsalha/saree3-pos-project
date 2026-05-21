"""
router: /auth/*
يتضمن Rate Limiting على /auth/login لمنع brute force
"""
import os
import time
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from database import get_db
from models import User
from schemas import UserOut
from auth import create_access_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])

_COOKIE_NAME = "pos_token"
_IS_SECURE   = os.getenv("COOKIE_SECURE", "false").lower() == "true"
_TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "false").lower() == "true"
_COOKIE_DOMAIN = os.getenv("COOKIE_DOMAIN", "").strip() or None
_COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "lax").strip().lower()

if _COOKIE_SAMESITE not in {"lax", "strict", "none"}:
    _COOKIE_SAMESITE = "lax"

# ── Rate Limiter بسيط في الذاكرة ─────────────────────────────────────────────
# حد أقصى 10 محاولات فاشلة per IP خلال 5 دقائق
_login_failures: dict[str, list[float]] = defaultdict(list)
_RATE_WINDOW   = 300   # 5 دقائق بالثواني
_RATE_MAX_FAIL = 10    # عدد المحاولات الفاشلة المسموح بها

def _check_rate_limit(ip: str) -> None:
    now = time.time()
    # احذف المحاولات القديمة خارج النافذة
    _login_failures[ip] = [t for t in _login_failures[ip] if now - t < _RATE_WINDOW]
    if len(_login_failures[ip]) >= _RATE_MAX_FAIL:
        remaining = int(_RATE_WINDOW - (now - _login_failures[ip][0]))
        raise HTTPException(
            status_code=429,
            detail=f"تم تجاوز عدد محاولات الدخول — انتظر {remaining} ثانية",
            headers={"Retry-After": str(remaining)},
        )

def _record_failure(ip: str) -> None:
    _login_failures[ip].append(time.time())

def _clear_failures(ip: str) -> None:
    _login_failures.pop(ip, None)


def _client_ip_from_request(request: Request) -> str:
    if _TRUST_PROXY_HEADERS:
        forwarded_for = request.headers.get("X-Forwarded-For", "").strip()
        if forwarded_for:
            first_hop = forwarded_for.split(",")[0].strip()
            if first_hop:
                return first_hop
    return request.client.host if request.client else "unknown"


@router.post("/login")
async def login(
    request: Request,
    form: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
):
    # الـ IP للـ rate limiting
    client_ip = _client_ip_from_request(request)
    _check_rate_limit(client_ip)

    result = await db.execute(select(User).where(User.username == form.username))
    user = result.scalar_one_or_none()

    if not user or not verify_password(form.password, user.hashed_password):
        _record_failure(client_ip)   # سجّل المحاولة الفاشلة
        raise HTTPException(status_code=401, detail="بيانات الدخول غير صحيحة")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="الحساب موقف")

    _clear_failures(client_ip)      # نجاح — امسح سجل الفشل
    token = create_access_token({"sub": str(user.id), "role": user.role})

    resp = JSONResponse(content={
        "access_token": token,
        "token_type":   "bearer",
        "user":         UserOut.model_validate(user).model_dump(),
    })
    resp.set_cookie(
        key=_COOKIE_NAME, value=token,
        httponly=True,
        secure=_IS_SECURE,
        samesite=_COOKIE_SAMESITE,
        domain=_COOKIE_DOMAIN,
        max_age=7 * 24 * 3600,
        path="/",
    )
    return resp


@router.post("/logout")
async def logout():
    """مسح الـ cookie عند تسجيل الخروج"""
    resp = JSONResponse(content={"ok": True})
    resp.delete_cookie(key=_COOKIE_NAME, path="/", domain=_COOKIE_DOMAIN)
    return resp
