from __future__ import annotations

import os
from collections import defaultdict
from datetime import datetime, timedelta
from calendar import monthrange

from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from models import User, Session as CashierSession
from services.timezone_service import local_day_range, local_iso, local_month_range, local_now, to_local, utc_now

ATTENDANCE_TIMEOUT_MINUTES = int(os.getenv("ATTENDANCE_TIMEOUT_MINUTES", "5"))
ATTENDANCE_TIMEOUT_SECONDS = ATTENDANCE_TIMEOUT_MINUTES * 60
MAX_REASONABLE_SESSION_HOURS = int(os.getenv("MAX_REASONABLE_SESSION_HOURS", "16"))

def format_dt(dt: datetime | None) -> str | None:
    return local_iso(dt)


def month_bounds(year: int, month: int) -> tuple[datetime, datetime]:
    return local_month_range(f"{year:04d}-{month:02d}")


def same_day_bounds_local(year: int, month: int, day: int) -> tuple[datetime, datetime]:
    start_local = datetime(year, month, day)
    end_local = start_local + timedelta(days=1)
    return start_local, end_local


def is_session_online(session: CashierSession | None, now: datetime | None = None) -> bool:
    if not session or not session.is_active:
        return False
    now = now or utc_now()
    ref = session.last_presence_at or session.last_activity_at or session.opened_at
    return (now - ref).total_seconds() <= ATTENDANCE_TIMEOUT_SECONDS


async def touch_session_presence(db: AsyncSession, session_token: str | None = None, user_id: int | None = None, now: datetime | None = None) -> CashierSession | None:
    now = now or utc_now()
    stmt = select(CashierSession).where(CashierSession.is_active == True)
    if session_token:
        stmt = stmt.where(CashierSession.session_token == session_token)
    elif user_id is not None:
        stmt = stmt.where(CashierSession.user_id == user_id)
    else:
        return None
    session = (await db.execute(stmt.order_by(CashierSession.opened_at.desc()))).scalars().first()
    if not session:
        return None
    session.last_activity_at = now
    session.last_presence_at = now
    return session


async def reconcile_stale_sessions(db: AsyncSession, user_id: int | None = None, now: datetime | None = None) -> list[CashierSession]:
    now = now or utc_now()
    stmt = select(CashierSession).where(CashierSession.is_active == True)
    if user_id is not None:
        stmt = stmt.where(CashierSession.user_id == user_id)
    sessions = (await db.execute(stmt)).scalars().all()
    changed = []
    for session in sessions:
        ref = session.last_presence_at or session.last_activity_at or session.opened_at
        stale = (now - ref).total_seconds() > ATTENDANCE_TIMEOUT_SECONDS
        too_long = (now - session.opened_at).total_seconds() > (MAX_REASONABLE_SESSION_HOURS * 3600)
        if stale or too_long:
            session.is_active = False
            session.closed_at = ref if ref and ref >= session.opened_at else now
            session.disconnect_reason = 'timeout' if stale else 'system_cleanup'
            session.ended_by = 'timeout' if stale else 'system_cleanup'
            session.is_abnormal = True
            changed.append(session)
    if changed:
        await db.commit()
    return changed


async def close_session_record(
    db: AsyncSession,
    session: CashierSession,
    *,
    ended_by: str,
    disconnect_reason: str,
    abnormal: bool = False,
    closed_at: datetime | None = None,
) -> CashierSession:
    if not session:
        return session
    session.is_active = False
    session.closed_at = max(closed_at or utc_now(), session.opened_at)
    session.disconnect_reason = disconnect_reason
    session.ended_by = ended_by
    session.is_abnormal = abnormal
    await db.commit()
    return session


async def get_latest_session_map(db: AsyncSession, user_ids: list[int]) -> dict[int, CashierSession]:
    if not user_ids:
        return {}
    sessions = (await db.execute(
        select(CashierSession)
        .where(CashierSession.user_id.in_(user_ids))
        .order_by(CashierSession.user_id, CashierSession.opened_at.desc())
    )).scalars().all()
    result: dict[int, CashierSession] = {}
    for s in sessions:
        result.setdefault(s.user_id, s)
    return result


async def get_day_total_seconds(db: AsyncSession, user_id: int, year: int, month: int, day: int, now: datetime | None = None) -> int:
    now = now or utc_now()
    start_utc, end_utc = local_day_range(f"{year:04d}-{month:02d}-{day:02d}")
    sessions = (await db.execute(
        select(CashierSession).where(
            CashierSession.user_id == user_id,
            CashierSession.opened_at < end_utc,
            or_(CashierSession.closed_at == None, CashierSession.closed_at > start_utc, CashierSession.is_active == True),
        )
    )).scalars().all()
    total = 0
    for s in sessions:
        end = s.closed_at or s.last_presence_at or s.last_activity_at or now
        if end < s.opened_at:
            end = s.opened_at
        total += int(max(0, (min(end, end_utc) - max(s.opened_at, start_utc)).total_seconds()))
    return total


async def monthly_attendance_report(db: AsyncSession, year: int, month: int, user_id: int | None = None, employee_name: str | None = None) -> list[dict]:
    await reconcile_stale_sessions(db)
    now = utc_now()
    utc_start, utc_end = month_bounds(year, month)
    user_stmt = select(User).where(User.is_active == True)
    if user_id:
        user_stmt = user_stmt.where(User.id == user_id)
    if employee_name:
        like = f"%{employee_name.strip()}%"
        user_stmt = user_stmt.where(or_(User.name.ilike(like), User.username.ilike(like)))
    users = (await db.execute(user_stmt.order_by(User.name.asc()))).scalars().all()
    if not users:
        return []

    user_ids = [u.id for u in users]
    sessions = (await db.execute(
        select(CashierSession).where(
            CashierSession.user_id.in_(user_ids),
            CashierSession.opened_at < utc_end,
            or_(CashierSession.closed_at == None, CashierSession.closed_at >= utc_start, CashierSession.is_active == True),
        ).order_by(CashierSession.user_id.asc(), CashierSession.opened_at.asc())
    )).scalars().all()

    latest_map = await get_latest_session_map(db, user_ids)
    days_in_month = monthrange(year, month)[1]
    report: dict[int, dict] = {}
    for u in users:
        latest = latest_map.get(u.id)
        report[u.id] = {
            'employee_id': u.id,
            'employee_name': u.name,
            'username': u.username,
            'role': u.role,
            'selected_month': f'{year}-{month:02d}',
            'current_status': 'connected' if is_session_online(latest, now) else 'disconnected',
            'last_seen': format_dt((latest.last_presence_at if latest else None) or (latest.last_activity_at if latest else None) or (latest.opened_at if latest else None)),
            'daily': [],
            'total_monthly_seconds': 0,
            'abnormal_days_count': 0,
        }
    daily_meta: dict[tuple[int, int], dict] = defaultdict(lambda: {
        'seconds': 0, 'abnormal': False, 'sessions_count': 0,
                'first_connected': None, 'last_disconnected': None, 'status_note': None,
    })

    for s in sessions:
        if s.user_id not in report:
            continue
        real_end = s.closed_at or s.last_presence_at or s.last_activity_at or now
        if real_end < s.opened_at:
            real_end = s.opened_at
        current_local = to_local(s.opened_at)
        end_local = to_local(real_end)
        while current_local.date() <= end_local.date():
            if current_local.year == year and current_local.month == month:
                day = current_local.day
                meta = daily_meta[(s.user_id, day)]
                day_start_utc, day_end_utc = local_day_range(f"{year:04d}-{month:02d}-{day:02d}")
                overlap_start = max(s.opened_at, day_start_utc)
                overlap_end = min(real_end, day_end_utc)
                secs = int(max(0, (overlap_end - overlap_start).total_seconds()))
                if secs > 0:
                    meta['seconds'] += secs
                    meta['sessions_count'] += 1
                    if not meta['first_connected'] or overlap_start < meta['first_connected']:
                        meta['first_connected'] = overlap_start
                    if not meta['last_disconnected'] or overlap_end > meta['last_disconnected']:
                        meta['last_disconnected'] = overlap_end
                if s.is_abnormal or s.disconnect_reason in {'timeout', 'dropped', 'system_cleanup'}:
                    meta['abnormal'] = True
            current_local += timedelta(days=1)

    for u in users:
        for day in range(1, days_in_month + 1):
            meta = daily_meta[(u.id, day)]
            if meta['abnormal']:
                report[u.id]['abnormal_days_count'] += 1
            report[u.id]['total_monthly_seconds'] += meta['seconds']
            report[u.id]['daily'].append({
                'day': day,
                'date': f'{year}-{month:02d}-{day:02d}',
                'connected_seconds': meta['seconds'],
                'connected_hours': round(meta['seconds'] / 3600, 2),
                'sessions_count': meta['sessions_count'],
                'is_abnormal': meta['abnormal'],
                'first_connected': format_dt(meta['first_connected']),
                'last_disconnected': format_dt(meta['last_disconnected']),
                'status_note': meta['status_note'],
            })
        report[u.id]['total_monthly_hours'] = round(report[u.id]['total_monthly_seconds'] / 3600, 2)
    return list(report.values())


async def attendance_status_overview(db: AsyncSession, employee_id: int | None = None, employee_name: str | None = None) -> dict:
    await reconcile_stale_sessions(db, user_id=employee_id)
    now = utc_now()
    today_local = local_now()
    stmt = select(User).where(User.is_active == True)
    if employee_id:
        stmt = stmt.where(User.id == employee_id)
    if employee_name:
        like = f"%{employee_name.strip()}%"
        stmt = stmt.where(or_(User.name.ilike(like), User.username.ilike(like)))
    users = (await db.execute(stmt.order_by(User.name.asc()))).scalars().all()
    latest_map = await get_latest_session_map(db, [u.id for u in users])
    employees = []
    connected_count = disconnected_count = 0
    total_today = 0
    for u in users:
        latest = latest_map.get(u.id)
        online = is_session_online(latest, now)
        status = 'connected' if online else 'disconnected'
        if online:
            connected_count += 1
        else:
            disconnected_count += 1
        today_seconds = await get_day_total_seconds(db, u.id, today_local.year, today_local.month, today_local.day, now)
        total_today += today_seconds
        employees.append({
            'employee_id': u.id,
            'employee_name': u.name,
            'username': u.username,
            'role': u.role,
            'status': status,
            'today_connected_seconds': today_seconds,
            'today_connected_hours': round(today_seconds / 3600, 2),
            'last_seen': format_dt((latest.last_presence_at if latest else None) or (latest.last_activity_at if latest else None) or (latest.opened_at if latest else None)),
            'active_since': format_dt(latest.opened_at if online and latest else None),
            'is_abnormal': bool(latest.is_abnormal) if latest else False,
            'disconnect_reason': latest.disconnect_reason if latest else None,
        })
    return {
        'summary': {
            'employees_count': len(employees),
            'connected_count': connected_count,
            'disconnected_count': disconnected_count,
            'today_total_connected_hours': round(total_today / 3600, 2),
        },
        'employees': employees,
    }


async def employee_month_detail(db: AsyncSession, user_id: int, year: int, month: int) -> dict | None:
    report = await monthly_attendance_report(db, year, month, user_id=user_id)
    if not report:
        return None
    employee = report[0]
    utc_start, utc_end = month_bounds(year, month)
    sessions = (await db.execute(
        select(CashierSession).where(
            CashierSession.user_id == user_id,
            CashierSession.opened_at < utc_end,
            or_(CashierSession.closed_at == None, CashierSession.closed_at >= utc_start, CashierSession.is_active == True),
        ).order_by(CashierSession.opened_at.asc())
    )).scalars().all()
    fragments = []
    now = utc_now()
    for s in sessions:
        end = s.closed_at or s.last_presence_at or s.last_activity_at or now
        if end < s.opened_at:
            end = s.opened_at
        fragments.append({
            'session_id': s.id,
            'opened_at': format_dt(s.opened_at),
            'closed_at': format_dt(end),
            'ended_by': s.ended_by,
            'disconnect_reason': s.disconnect_reason,
            'is_abnormal': s.is_abnormal,
        })
    employee['session_fragments'] = fragments
    return employee



def format_hours_compact(hours: float | int | None) -> str:
    hours = float(hours or 0)
    total_minutes = int(round(hours * 60))
    h, m = divmod(total_minutes, 60)
    if h and m:
        return f"{h}h {m}m"
    if h:
        return f"{h}h"
    return f"{m}m"


def format_telegram_duration(seconds: int | None) -> str:
    total_minutes = max(0, int((seconds or 0) / 60))
    h, m = divmod(total_minutes, 60)
    if h and m:
        return f"{h} ساعة {m} دقيقة"
    if h:
        return f"{h} ساعة"
    return f"{m} دقيقة"


def chunk_text_lines(lines: list[str], limit: int = 3500) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for line in lines:
        piece_len = len(line) + 1
        if current and current_len + piece_len > limit:
            chunks.append("\n".join(current))
            current = [line]
            current_len = piece_len
        else:
            current.append(line)
            current_len += piece_len
    if current:
        chunks.append("\n".join(current))
    return chunks


def build_employee_daily_lines(employee: dict, *, only_abnormal: bool = False) -> list[str]:
    lines: list[str] = []
    for day in employee.get('daily', []):
        if only_abnormal and not (day.get('is_abnormal') or day.get('status_note')):
            continue
        suffix = []
        if day.get('is_abnormal'):
            suffix.append('⚠️ غير مكتمل')
        if day.get('status_note'):
            suffix.append(f"ðŸ“ {day['status_note']}")
        tail = f" â€” {' | '.join(suffix)}" if suffix else ''
        lines.append(f"• يوم {day['day']:02d}: {format_telegram_duration(day.get('connected_seconds', 0))}{tail}")
    return lines
