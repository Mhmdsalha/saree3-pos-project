from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from routers.deps import require_admin, require_manager
from schemas import WorkdayHoursSettingOut, WorkdayHoursSettingUpdate
from services.system_settings_service import (
    format_workday_hours_label,
    get_workday_hours_setting,
    normalize_workday_hours,
    upsert_system_setting,
)

router = APIRouter(prefix="/system-settings", tags=["system-settings"])


@router.get("/workday-hours", response_model=WorkdayHoursSettingOut)
async def get_workday_hours(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    value = await get_workday_hours_setting(db)
    return {
        "value": value,
        "label": format_workday_hours_label(value),
    }


@router.put("/workday-hours", response_model=WorkdayHoursSettingOut)
async def update_workday_hours(
    payload: WorkdayHoursSettingUpdate,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_admin),
):
    try:
        value = normalize_workday_hours(payload.value)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    await upsert_system_setting(
        db,
        key="attendance_workday_hours",
        value=f"{value:.2f}",
        description="عدد ساعات العمل اليومية المعتمدة لتقييم الحضور والساعات الإضافية",
    )
    await db.commit()
    return {
        "value": float(value),
        "label": format_workday_hours_label(value),
    }
