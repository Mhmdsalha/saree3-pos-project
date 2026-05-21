from datetime import datetime, timedelta
import os
import sys

from fastapi import HTTPException
import jwt
from passlib.context import CryptContext
from dotenv import load_dotenv
from services.timezone_service import utc_now

_DEFAULT_SECRET_KEY = "supermarket-pos-secret-2024-change-in-production"


def _load_env_files() -> None:
    candidates = []
    configured = os.getenv("FLOWPOS_ENV_FILE", "").strip()
    if configured:
        candidates.append(configured)
    module_env = os.path.join(os.path.dirname(__file__), ".env")
    candidates.append(module_env)
    meipass = getattr(sys, "_MEIPASS", "") if "sys" in globals() else ""
    if meipass:
        candidates.append(os.path.join(meipass, ".env"))
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            load_dotenv(candidate, override=False)

_load_env_files()


def _load_secret_key() -> str:
    secret = os.getenv("SECRET_KEY", "").strip()
    if not secret:
        raise RuntimeError("المتغير SECRET_KEY مطلوب قبل تشغيل السيرفر.")
    if secret == _DEFAULT_SECRET_KEY:
        raise RuntimeError("لا يجوز استخدام القيمة الافتراضية غير الآمنة في SECRET_KEY.")
    if len(secret) < 32:
        raise RuntimeError("يجب أن يكون SECRET_KEY بطول 32 حرفًا على الأقل.")
    return secret


SECRET_KEY = _load_secret_key()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    to_encode["exp"] = utc_now() + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="التوكن غير صالح")
