from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Lock
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:  # pragma: no cover - optional dependency, validated through fallback behavior
    import ntplib  # type: ignore
except Exception:  # pragma: no cover - keep runtime functional without the package
    ntplib = None  # type: ignore[assignment]


DEFAULT_TIMEZONE = os.getenv("APP_TIMEZONE", "Asia/Jerusalem").strip() or "Asia/Jerusalem"
_FALLBACK_OFFSET_HOURS = int(os.getenv("TZ_OFFSET_HOURS", "2"))
DEFAULT_NTP_SERVERS = ("pool.ntp.org", "time.google.com", "time.cloudflare.com")
_TRUSTED_TIME_CACHE_LOCK = Lock()
_TRUSTED_TIME_CACHE: "_TrustedTimeCache | None" = None


@dataclass(frozen=True)
class TrustedTimeSnapshot:
    utc_now: datetime
    source: str
    trusted: bool
    reason: str | None = None
    server: str | None = None
    offset_seconds: float | None = None
    fetched_at: datetime | None = None


@dataclass(frozen=True)
class _TrustedTimeCache:
    snapshot: TrustedTimeSnapshot
    monotonic_at: float


def _build_local_timezone():
    try:
        return ZoneInfo(DEFAULT_TIMEZONE)
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=_FALLBACK_OFFSET_HOURS), name=f"UTC{_FALLBACK_OFFSET_HOURS:+03d}:00")


LOCAL_TIMEZONE = _build_local_timezone()


def _to_utc_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _to_naive_utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def local_now() -> datetime:
    return datetime.now(timezone.utc).astimezone(LOCAL_TIMEZONE)


def utc_now() -> datetime:
    # Keep UTC-naive timestamps for backward compatibility with the existing DB schema,
    # while avoiding deprecated datetime.utcnow() calls on newer Python versions.
    return datetime.now(timezone.utc).replace(tzinfo=None)


def clear_trusted_time_cache() -> None:
    global _TRUSTED_TIME_CACHE
    with _TRUSTED_TIME_CACHE_LOCK:
        _TRUSTED_TIME_CACHE = None


def _trusted_time_enabled() -> bool:
    return os.getenv("FLOWPOS_TRUSTED_TIME_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}


def _trusted_time_cache_seconds() -> int:
    try:
        return max(0, int(os.getenv("FLOWPOS_TRUSTED_TIME_CACHE_SECONDS", "600")))
    except Exception:
        return 600


def _trusted_time_timeout_seconds() -> float:
    try:
        return max(0.1, float(os.getenv("FLOWPOS_NTP_TIMEOUT_SECONDS", "0.8")))
    except Exception:
        return 0.8


def _trusted_time_servers() -> list[str]:
    configured = os.getenv("FLOWPOS_NTP_SERVERS", "").strip()
    if not configured:
        return list(DEFAULT_NTP_SERVERS)
    normalized = configured
    for separator in (";", "\n", "\r"):
        normalized = normalized.replace(separator, ",")
    servers = [part.strip() for part in normalized.split(",") if part.strip()]
    return servers or list(DEFAULT_NTP_SERVERS)


def _build_trusted_snapshot(
    *,
    utc_value: datetime,
    source: str,
    trusted: bool,
    reason: str | None = None,
    server: str | None = None,
    offset_seconds: float | None = None,
) -> TrustedTimeSnapshot:
    return TrustedTimeSnapshot(
        utc_now=utc_value.replace(tzinfo=None),
        source=source,
        trusted=trusted,
        reason=reason,
        server=server,
        offset_seconds=offset_seconds,
        fetched_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )


def _query_ntp_snapshot() -> TrustedTimeSnapshot:
    if ntplib is None:
        raise RuntimeError("ntplib_unavailable")

    client = ntplib.NTPClient()
    failures: list[str] = []
    timeout = _trusted_time_timeout_seconds()

    for server in _trusted_time_servers():
        try:
            response = client.request(server, version=3, timeout=timeout)
            offset = getattr(response, "offset", None)
            return _build_trusted_snapshot(
                utc_value=datetime.fromtimestamp(response.tx_time, tz=timezone.utc),
                source="ntp",
                trusted=True,
                server=server,
                offset_seconds=float(offset) if offset is not None else None,
            )
        except Exception as exc:
            failures.append(f"{server}:{exc.__class__.__name__}")

    raise RuntimeError("; ".join(failures) if failures else "ntp_unavailable")


def _snapshot_from_cache() -> TrustedTimeSnapshot | None:
    with _TRUSTED_TIME_CACHE_LOCK:
        cached = _TRUSTED_TIME_CACHE
    if not cached:
        return None

    elapsed = max(0.0, time.monotonic() - cached.monotonic_at)
    if elapsed <= 0:
        elapsed = 0.0
    return TrustedTimeSnapshot(
        utc_now=cached.snapshot.utc_now + timedelta(seconds=elapsed),
        source="ntp_cache" if cached.snapshot.trusted else cached.snapshot.source,
        trusted=cached.snapshot.trusted,
        reason=cached.snapshot.reason,
        server=cached.snapshot.server,
        offset_seconds=cached.snapshot.offset_seconds,
        fetched_at=cached.snapshot.fetched_at,
    )


def trusted_utc_now(force_refresh: bool = False) -> TrustedTimeSnapshot:
    if not _trusted_time_enabled():
        return _build_trusted_snapshot(
            utc_value=datetime.now(timezone.utc),
            source="local_fallback",
            trusted=False,
            reason="trusted_time_disabled",
        )

    cached = None if force_refresh else _snapshot_from_cache()
    cache_ttl_seconds = _trusted_time_cache_seconds()
    if cached and (cache_ttl_seconds <= 0 or (datetime.now(timezone.utc).replace(tzinfo=None) - cached.fetched_at).total_seconds() <= cache_ttl_seconds):
        return cached

    try:
        snapshot = _query_ntp_snapshot()
    except Exception as exc:
        cached = _snapshot_from_cache()
        if cached and cached.trusted:
            return TrustedTimeSnapshot(
                utc_now=cached.utc_now,
                source="ntp_cache",
                trusted=True,
                reason=f"ntp_refresh_failed:{exc}",
                server=cached.server,
                offset_seconds=cached.offset_seconds,
                fetched_at=cached.fetched_at,
            )
        return _build_trusted_snapshot(
            utc_value=datetime.now(timezone.utc),
            source="local_fallback",
            trusted=False,
            reason=f"ntp_unavailable:{exc}",
        )

    with _TRUSTED_TIME_CACHE_LOCK:
        global _TRUSTED_TIME_CACHE
        _TRUSTED_TIME_CACHE = _TrustedTimeCache(snapshot=snapshot, monotonic_at=time.monotonic())
    return snapshot


def to_local(value: datetime | None) -> datetime | None:
    if not value:
        return None
    return _to_utc_aware(value).astimezone(LOCAL_TIMEZONE)


def local_iso(value: datetime | None) -> str | None:
    localized = to_local(value)
    return localized.isoformat() if localized else None


def local_day_range(date_str: str | None = None) -> tuple[datetime, datetime]:
    if date_str:
        parsed = datetime.fromisoformat(date_str)
        local_anchor = parsed.astimezone(LOCAL_TIMEZONE) if parsed.tzinfo else parsed.replace(tzinfo=LOCAL_TIMEZONE)
    else:
        local_anchor = local_now()

    local_start = local_anchor.replace(hour=0, minute=0, second=0, microsecond=0)
    local_end = local_start + timedelta(days=1)
    return _to_naive_utc(local_start), _to_naive_utc(local_end)


def local_month_range(month_str: str | None = None) -> tuple[datetime, datetime]:
    if month_str:
        local_start = datetime.fromisoformat(month_str + "-01").replace(tzinfo=LOCAL_TIMEZONE)
    else:
        current_local = local_now()
        local_start = current_local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    if local_start.month == 12:
        local_end = local_start.replace(year=local_start.year + 1, month=1)
    else:
        local_end = local_start.replace(month=local_start.month + 1)
    return _to_naive_utc(local_start), _to_naive_utc(local_end)
