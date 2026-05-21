from __future__ import annotations

from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import SystemSetting

WORKDAY_HOURS_KEY = "attendance_workday_hours"
DEFAULT_WORKDAY_HOURS = Decimal("8.00")
MIN_WORKDAY_HOURS = Decimal("1.00")
MAX_WORKDAY_HOURS = Decimal("24.00")


def normalize_workday_hours(value) -> Decimal:
    try:
        normalized = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("عدد ساعات العمل اليومي غير صالح")
    if normalized < MIN_WORKDAY_HOURS or normalized > MAX_WORKDAY_HOURS:
        raise ValueError("عدد ساعات العمل اليومي يجب أن يكون بين 1 و24 ساعة")
    return normalized


def format_workday_hours_label(value) -> str:
    normalized = normalize_workday_hours(value)
    compact = f"{normalized:.2f}".rstrip("0").rstrip(".")
    return f"{compact}+ ساعة"


async def get_system_setting_value(
    db: AsyncSession,
    key: str,
    default: str | None = None,
) -> str | None:
    row = (await db.execute(select(SystemSetting).where(SystemSetting.key == key))).scalar_one_or_none()
    return row.value if row and row.value is not None else default


async def upsert_system_setting(
    db: AsyncSession,
    *,
    key: str,
    value: str,
    description: str | None = None,
) -> SystemSetting:
    setting = (await db.execute(select(SystemSetting).where(SystemSetting.key == key))).scalar_one_or_none()
    if not setting:
        setting = SystemSetting(key=key, value=value, description=description)
        db.add(setting)
    else:
        setting.value = value
        if description is not None:
            setting.description = description
    await db.flush()
    return setting


async def get_workday_hours_setting(db: AsyncSession) -> float:
    raw = await get_system_setting_value(db, WORKDAY_HOURS_KEY, str(DEFAULT_WORKDAY_HOURS))
    try:
        return float(normalize_workday_hours(raw))
    except ValueError:
        return float(DEFAULT_WORKDAY_HOURS)
