"""
Shared dependencies for backend routers.
"""

from fastapi import Cookie, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_token
from database import get_db
from models import User

_COOKIE_NAME = "pos_token"


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
    cookie_token: str | None = Cookie(default=None, alias=_COOKIE_NAME),
) -> User:
    token = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
    elif cookie_token:
        token = cookie_token

    if not token:
        raise HTTPException(status_code=401, detail="يرجى تسجيل الدخول أولًا")

    payload = verify_token(token)
    result = await db.execute(select(User).where(User.id == int(payload["sub"])))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="المستخدم غير موجود")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="الحساب موقوف")

    return user


async def require_manager(user: User = Depends(get_current_user)) -> User:
    if user.role not in ["admin", "supervisor"]:
        raise HTTPException(status_code=403, detail="غير مصرح بهذه العملية")
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="هذه العملية متاحة للمدير فقط")
    return user


async def require_admin_only(user: User = Depends(get_current_user)) -> User:
    return await require_admin(user)
