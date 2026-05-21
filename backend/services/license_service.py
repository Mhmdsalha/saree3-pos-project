from __future__ import annotations

import base64
import json
import os
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from fastapi import HTTPException

from services.license_local_protection_service import (
    SECURE_STATE_FILE_NAME,
    SUMMARY_STATE_FILE_NAME,
    clear_protected_license_state,
    load_protected_license_state,
    save_protected_license_state,
)
from services.system_branding import SYSTEM_BRAND_NAME
from services.timezone_service import TrustedTimeSnapshot, trusted_utc_now

TRIAL_DAYS = 7
SUPPORT_WHATSAPP_NUMBER = "972569383482"
INSTALLATION_ID_FILE_NAME = "installation-id.txt"
ACTIVATION_PREFIX = "FP1"
DEFAULT_LICENSE_PUBLIC_KEYS_B64 = (
    "gOccapnu3kjM8oe8HhCbWllijpdq8uUKz8N2VQt9QVM=",
    "ew6dbcCbFpBVERSLjTqvRzKZedfFlIvH8p/hsHxkEik=",
)
DEFAULT_ADMIN_KEY_DIR = (Path.home() / ".saree-license-admin").resolve()
DEFAULT_LICENSE_PRIVATE_KEY_FILE = DEFAULT_ADMIN_KEY_DIR / "flowpos-license-private.b64"
LIFETIME_SUBSCRIPTION_TERM = "lifetime"
CLOCK_ROLLBACK_TOLERANCE_SECONDS = 300


def _config_dir() -> Path:
    configured = os.getenv("FLOWPOS_CONFIG_DIR", "").strip()
    path = Path(configured) if configured else Path(__file__).resolve().parent.parent / ".flowpos-config"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _summary_state_path() -> Path:
    return _config_dir() / SUMMARY_STATE_FILE_NAME


def _secure_state_path() -> Path:
    return _config_dir() / SECURE_STATE_FILE_NAME


def _installation_id_path() -> Path:
    return _config_dir() / INSTALLATION_ID_FILE_NAME


def _to_iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _from_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None


def _base64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")


def base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def generate_license_keypair_b64() -> tuple[str, str]:
    private_key = Ed25519PrivateKey.generate()
    private_key_raw = private_key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_key_raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(private_key_raw).decode(), base64.b64encode(public_key_raw).decode()


def load_private_license_key_b64() -> str:
    direct_value = os.getenv("FLOWPOS_LICENSE_PRIVATE_KEY_B64", "").strip()
    if direct_value:
        return direct_value

    configured_path = os.getenv("FLOWPOS_LICENSE_PRIVATE_KEY_FILE", "").strip()
    candidate_paths = [configured_path] if configured_path else []
    candidate_paths.append(str(DEFAULT_LICENSE_PRIVATE_KEY_FILE))

    for candidate in candidate_paths:
        clean_candidate = str(candidate or "").strip()
        if not clean_candidate:
            continue
        path = Path(clean_candidate)
        if path.exists():
            value = path.read_text(encoding="utf-8").strip()
            if value:
                return value
    raise HTTPException(500, "تعذر تحميل المفتاح الخاص بالتفعيل.")


def build_activation_token(private_key_b64: str, payload: dict[str, Any]) -> str:
    try:
        private_key_raw = base64.b64decode(str(private_key_b64 or "").strip())
        private_key = Ed25519PrivateKey.from_private_bytes(private_key_raw)
    except Exception as exc:
        raise ValueError(f"تعذر تحميل المفتاح الخاص: {exc}") from exc

    encoded_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    signature = private_key.sign(encoded_payload)
    return f"{ACTIVATION_PREFIX}.{base64url_encode(encoded_payload)}.{base64url_encode(signature)}"


def decode_activation_token_payload(token: str) -> dict[str, Any]:
    raw = str(token or "").strip()
    parts = raw.split(".")
    if len(parts) != 3 or parts[0] != ACTIVATION_PREFIX:
        raise ValueError("صيغة كود التفعيل غير صالحة")

    try:
        payload_bytes = _base64url_decode(parts[1])
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"تعذر قراءة بيانات كود التفعيل: {exc}") from exc

    if not isinstance(payload, dict):
        raise ValueError("بيانات كود التفعيل غير صالحة")
    return payload


def _load_public_keys() -> list[Ed25519PublicKey]:
    configured = os.getenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", "").strip()
    encoded_candidates: list[str] = []

    if configured:
        normalized = configured
        for separator in (";", "\n", "\r"):
            normalized = normalized.replace(separator, ",")
        encoded_candidates.extend(part.strip() for part in normalized.split(",") if part.strip())

    for default_key in DEFAULT_LICENSE_PUBLIC_KEYS_B64:
        if default_key not in encoded_candidates:
            encoded_candidates.append(default_key)

    public_keys: list[Ed25519PublicKey] = []
    for encoded in encoded_candidates:
        try:
            raw = base64.b64decode(encoded)
            public_keys.append(Ed25519PublicKey.from_public_bytes(raw))
        except Exception:
            continue

    if not public_keys:
        raise HTTPException(500, "تعذر تحميل مفاتيح التحقق من التراخيص.")
    return public_keys


def resolve_installation_id() -> str:
    direct = os.getenv("FLOWPOS_INSTALLATION_ID", "").strip()
    if direct:
        return direct

    path = _installation_id_path()
    if path.exists():
        value = path.read_text(encoding="utf-8").strip()
        if value:
            return value

    installation_id = f"inst-{secrets.token_hex(12)}"
    path.write_text(installation_id, encoding="utf-8")
    return installation_id


def _calculate_remaining_days(expires_at: datetime | None, now: datetime) -> int | None:
    if not expires_at:
        return None
    remaining_seconds = (expires_at - now).total_seconds()
    if remaining_seconds <= 0:
        return 0
    return max(0, int(remaining_seconds // 86400) + (1 if remaining_seconds % 86400 > 0 else 0))


def _license_clock(force_refresh: bool = False) -> TrustedTimeSnapshot:
    return trusted_utc_now(force_refresh=force_refresh)


def _clock_payload(clock: TrustedTimeSnapshot) -> dict[str, Any]:
    return {
        "current_time_utc": clock.utc_now.isoformat(),
        "time_source": clock.source,
        "time_sync_status": "trusted" if clock.trusted else "fallback",
        "time_trusted": clock.trusted,
        "time_reason": clock.reason,
        "time_server": clock.server,
        "time_offset_seconds": clock.offset_seconds,
        "time_fetched_at": clock.fetched_at.isoformat() if clock.fetched_at else None,
    }


def _parse_sequence_number(value: Any) -> int:
    try:
        parsed = int(value)
    except Exception as exc:
        raise HTTPException(400, "الرمز لا يحتوي على رقم تسلسلي صالح.") from exc
    if parsed <= 0:
        raise HTTPException(400, "الرقم التسلسلي للترخيص غير صالح.")
    return parsed


def _resolve_stored_sequence_number(raw: dict[str, Any] | None) -> int | None:
    if not raw:
        return None
    existing = raw.get("sequence_number", raw.get("current_sequence_number"))
    if existing in (None, ""):
        return None
    try:
        parsed = int(existing)
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _resolve_verified_sequence_number(verified: dict[str, Any], raw: dict[str, Any] | None = None) -> int:
    value = verified.get("sequence_number")
    if value not in (None, ""):
        return _parse_sequence_number(value)

    stored_sequence_number = _resolve_stored_sequence_number(raw)
    if stored_sequence_number:
        return stored_sequence_number

    has_legacy_active_state = bool(raw and raw.get("license_id") and raw.get("activation_payload"))
    if has_legacy_active_state:
        return 1

    has_legacy_token_identity = bool(str(verified.get("license_id") or "").strip())
    if has_legacy_token_identity:
        return 1

    raise HTTPException(400, "الرمز لا يحتوي على رقم تسلسلي صالح.")


def _verify_activation_token(token: str) -> dict[str, Any]:
    raw = str(token or "").strip()
    parts = raw.split(".")
    if len(parts) != 3 or parts[0] != ACTIVATION_PREFIX:
        raise HTTPException(400, "صيغة كود التفعيل غير صالحة")

    payload_part, signature_part = parts[1], parts[2]
    try:
        payload_bytes = _base64url_decode(payload_part)
        signature = _base64url_decode(signature_part)
    except Exception:
        raise HTTPException(400, "تعذر قراءة كود التفعيل")

    verification_error: Exception | None = None
    for public_key in _load_public_keys():
        try:
            public_key.verify(signature, payload_bytes)
            verification_error = None
            break
        except InvalidSignature as exc:
            verification_error = exc
        except Exception as exc:
            verification_error = exc

    if verification_error is not None:
        if isinstance(verification_error, InvalidSignature):
            raise HTTPException(400, "كود التفعيل غير صالح")
        raise HTTPException(400, f"تعذر التحقق من كود التفعيل: {verification_error}")

    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception:
        raise HTTPException(400, "بيانات كود التفعيل غير قابلة للقراءة")

    if not isinstance(payload, dict):
        raise HTTPException(400, "بيانات كود التفعيل غير صالحة")

    return payload


def _normalize_state(payload: dict[str, Any]) -> dict[str, Any]:
    used_ids_raw = payload.get("used_license_ids") or []
    if not isinstance(used_ids_raw, list):
        used_ids_raw = []
    used_ids: list[str] = []
    for item in used_ids_raw:
        value = str(item or "").strip()
        if value and value not in used_ids:
            used_ids.append(value)

    license_id = str(payload.get("license_id") or payload.get("current_license_id") or "").strip() or None
    sequence_number = payload.get("sequence_number", payload.get("current_sequence_number"))
    if sequence_number in (None, ""):
        normalized_sequence = None
    else:
        try:
            normalized_sequence = int(sequence_number)
        except Exception:
            normalized_sequence = None

    if license_id and license_id not in used_ids:
        used_ids.append(license_id)

    return {
        "version": int(payload.get("version") or 2),
        "license_id": license_id,
        "current_license_id": license_id,
        "sequence_number": normalized_sequence,
        "current_sequence_number": normalized_sequence,
        "used_license_ids": used_ids,
        "store_id": payload.get("store_id"),
        "installation_id": payload.get("installation_id"),
        "license_type": payload.get("license_type"),
        "subscription_term": payload.get("subscription_term"),
        "license_status": payload.get("license_status"),
        "plan": payload.get("plan"),
        "trial_started_at": payload.get("trial_started_at"),
        "trial_expires_at": payload.get("trial_expires_at"),
        "activated_at": payload.get("activated_at"),
        "issued_at": payload.get("issued_at"),
        "expires_at": payload.get("expires_at"),
        "activation_payload": payload.get("activation_payload"),
        "consumed_at": payload.get("consumed_at") or payload.get("license_consumed_at"),
        "last_seen_local_at": payload.get("last_seen_local_at"),
        "last_known_valid_at": payload.get("last_known_valid_at") or payload.get("last_seen_local_at"),
        "current_time_utc": payload.get("current_time_utc"),
        "status_reason": payload.get("status_reason"),
        "previous_license_id": payload.get("previous_license_id"),
        "last_time_source": payload.get("last_time_source"),
        "last_time_reason": payload.get("last_time_reason"),
        "last_time_server": payload.get("last_time_server"),
        "last_time_trusted": payload.get("last_time_trusted"),
        "time_source": payload.get("time_source"),
        "time_sync_status": payload.get("time_sync_status"),
        "time_trusted": payload.get("time_trusted"),
        "time_reason": payload.get("time_reason"),
        "time_server": payload.get("time_server"),
        "time_offset_seconds": payload.get("time_offset_seconds"),
        "time_fetched_at": payload.get("time_fetched_at"),
    }


def _read_summary_state_payload() -> dict[str, Any] | None:
    summary_path = _summary_state_path()
    if not summary_path.exists():
        return None
    try:
        payload = json.loads(summary_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _can_repair_from_summary(summary_state: dict[str, Any], protected_state: dict[str, Any] | None = None) -> bool:
    normalized_summary = _normalize_state(summary_state)

    if protected_state is not None:
        normalized_protected = _normalize_state(protected_state)
        protected_identity = (
            str(normalized_protected.get("license_id") or "").strip(),
            normalized_protected.get("sequence_number"),
            str(normalized_protected.get("store_id") or "").strip(),
            str(normalized_protected.get("installation_id") or "").strip(),
        )
        summary_identity = (
            str(normalized_summary.get("license_id") or "").strip(),
            normalized_summary.get("sequence_number"),
            str(normalized_summary.get("store_id") or "").strip(),
            str(normalized_summary.get("installation_id") or "").strip(),
        )
        if protected_identity != summary_identity:
            return False

    if str(normalized_summary.get("license_type") or "").strip().lower() == "trial":
        return _from_iso(str(normalized_summary.get("trial_expires_at") or "").strip() or None) is not None

    activation_payload = str(normalized_summary.get("activation_payload") or "").strip()
    if not activation_payload:
        return False

    try:
        verified = _verify_activation_token(activation_payload)
    except HTTPException:
        return False

    summary_license_id = str(normalized_summary.get("license_id") or "").strip()
    if summary_license_id and summary_license_id != str(verified.get("license_id") or "").strip():
        return False

    summary_installation_id = str(normalized_summary.get("installation_id") or "").strip()
    if summary_installation_id and summary_installation_id != str(verified.get("installation_id") or "").strip():
        return False

    summary_store_id = str(normalized_summary.get("store_id") or "").strip()
    if summary_store_id and summary_store_id != str(verified.get("store_id") or "").strip():
        return False

    summary_sequence = normalized_summary.get("sequence_number")
    if summary_sequence is not None and int(summary_sequence) != _resolve_verified_sequence_number(verified, normalized_summary):
        return False

    return True


def _load_state_with_integrity() -> tuple[dict[str, Any] | None, str | None]:
    config_dir = _config_dir()
    state, issue = load_protected_license_state(config_dir)
    summary_payload = _read_summary_state_payload()
    if state is not None:
        normalized_state = _normalize_state(state)
        if issue and _secure_state_path().exists() and summary_payload and _can_repair_from_summary(summary_payload, normalized_state):
            repaired = _normalize_state(summary_payload)
            save_protected_license_state(config_dir, repaired)
            return repaired, None
        return normalized_state, issue

    legacy_path = _summary_state_path()
    if not legacy_path.exists():
        return None, issue

    try:
        legacy_payload = json.loads(legacy_path.read_text(encoding="utf-8"))
    except Exception:
        return None, "local_state_tampered"
    if not isinstance(legacy_payload, dict):
        return None, "local_state_tampered"

    if int(legacy_payload.get("version") or 1) >= 2:
        return None, "local_state_tampered"

    is_legacy_payload = int(legacy_payload.get("version") or 1) < 2 or "used_license_ids" not in legacy_payload
    if not is_legacy_payload:
        return None, "local_state_tampered"

    migrated = _normalize_state(legacy_payload)
    if migrated.get("license_id") and not migrated.get("sequence_number"):
        migrated["sequence_number"] = 1
        migrated["current_sequence_number"] = 1
    save_protected_license_state(config_dir, migrated)
    return migrated, issue


def load_license_state() -> dict[str, Any] | None:
    state, _issue = _load_state_with_integrity()
    return state


def save_license_state(payload: dict[str, Any]) -> None:
    save_protected_license_state(_config_dir(), _normalize_state(payload))


def clear_license_state() -> None:
    clear_protected_license_state(_config_dir())


def _is_clock_rollback_detected(raw: dict[str, Any] | None, now: datetime) -> bool:
    if not raw:
        return False
    last_seen_local_at = _from_iso(str(raw.get("last_seen_local_at") or "").strip() or None)
    if last_seen_local_at and now + timedelta(seconds=CLOCK_ROLLBACK_TOLERANCE_SECONDS) < last_seen_local_at:
        return True
    last_known_valid_at = _from_iso(str(raw.get("last_known_valid_at") or "").strip() or None)
    if last_known_valid_at and now + timedelta(seconds=CLOCK_ROLLBACK_TOLERANCE_SECONDS) < last_known_valid_at:
        return True
    return False


def _base_status_payload(raw: dict[str, Any] | None, store_id: str | None, installation_id: str) -> dict[str, Any]:
    payload = raw or {}
    return {
        "license_id": payload.get("license_id"),
        "sequence_number": payload.get("sequence_number"),
        "store_id": store_id or payload.get("store_id"),
        "installation_id": installation_id,
        "license_type": payload.get("license_type") or "pending",
        "subscription_term": payload.get("subscription_term"),
        "license_status": "pending",
        "plan": payload.get("plan"),
        "trial_started_at": payload.get("trial_started_at"),
        "trial_expires_at": payload.get("trial_expires_at"),
        "activated_at": payload.get("activated_at"),
        "issued_at": payload.get("issued_at"),
        "expires_at": payload.get("expires_at"),
        "remaining_days": None,
        "is_blocked": False,
        "reason": None,
        "status_reason": payload.get("status_reason"),
        "consumed_at": payload.get("consumed_at"),
        "last_seen_local_at": payload.get("last_seen_local_at"),
        "current_time_utc": payload.get("current_time_utc"),
        "last_time_source": payload.get("last_time_source"),
        "last_time_reason": payload.get("last_time_reason"),
        "last_time_server": payload.get("last_time_server"),
        "last_time_trusted": payload.get("last_time_trusted"),
        "time_source": payload.get("time_source"),
        "time_sync_status": payload.get("time_sync_status"),
        "time_trusted": payload.get("time_trusted"),
        "time_reason": payload.get("time_reason"),
        "time_server": payload.get("time_server"),
        "time_offset_seconds": payload.get("time_offset_seconds"),
        "time_fetched_at": payload.get("time_fetched_at"),
    }


def ensure_trial_initialized(store_id: str) -> dict[str, Any]:
    installation_id = resolve_installation_id()
    existing, _issue = _load_state_with_integrity()
    if existing and existing.get("store_id") == store_id and existing.get("installation_id") == installation_id:
        return existing

    clock = _license_clock()
    now = clock.utc_now
    payload = _normalize_state(
        {
            "version": 2,
            "license_id": None,
            "sequence_number": None,
            "used_license_ids": [],
            "store_id": store_id,
            "installation_id": installation_id,
            "license_type": "trial",
            "subscription_term": "trial",
            "license_status": "trial_active",
            "plan": "trial",
            "trial_started_at": _to_iso(now),
            "trial_expires_at": _to_iso(now + timedelta(days=TRIAL_DAYS)),
            "activated_at": None,
            "issued_at": None,
            "expires_at": None,
            "activation_payload": None,
            "consumed_at": None,
            "last_seen_local_at": _to_iso(now),
            "last_known_valid_at": _to_iso(now),
            "status_reason": None,
            "last_time_source": clock.source,
            "last_time_reason": clock.reason,
            "last_time_server": clock.server,
            "last_time_trusted": clock.trusted,
            "time_source": clock.source,
            "time_sync_status": "trusted" if clock.trusted else "fallback",
            "time_trusted": clock.trusted,
            "time_reason": clock.reason,
            "time_server": clock.server,
            "time_offset_seconds": clock.offset_seconds,
            "time_fetched_at": clock.fetched_at.isoformat() if clock.fetched_at else None,
        }
    )
    save_license_state(payload)
    return payload


def evaluate_license_state(store_id: str | None = None) -> dict[str, Any]:
    installation_id = resolve_installation_id()
    raw, integrity_issue = _load_state_with_integrity()
    clock = _license_clock()
    now = clock.utc_now
    payload = _base_status_payload(raw, store_id, installation_id)
    payload.update(_clock_payload(clock))

    if not raw:
        return payload

    if integrity_issue:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = integrity_issue
        payload["status_reason"] = integrity_issue
        return payload

    if raw.get("installation_id") and raw.get("installation_id") != installation_id:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "installation_mismatch"
        payload["status_reason"] = "installation_mismatch"
        return payload

    payload["store_id"] = raw.get("store_id") or payload["store_id"]
    payload["license_type"] = raw.get("license_type") or payload["license_type"]
    payload["subscription_term"] = raw.get("subscription_term") or payload["subscription_term"]
    payload["license_id"] = raw.get("license_id") or payload["license_id"]
    payload["sequence_number"] = raw.get("sequence_number") or payload["sequence_number"]

    if _is_clock_rollback_detected(raw, now):
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "clock_rollback_suspected"
        payload["status_reason"] = "clock_rollback_suspected"
        raw["status_reason"] = "clock_rollback_suspected"
        raw["last_time_source"] = clock.source
        raw["last_time_reason"] = clock.reason
        raw["last_time_server"] = clock.server
        raw["last_time_trusted"] = clock.trusted
        save_license_state(raw)
        return payload

    if raw.get("license_type") == "trial":
        expires_at = _from_iso(str(raw.get("trial_expires_at") or "").strip() or None)
        if not expires_at:
            payload["license_status"] = "invalid"
            payload["is_blocked"] = True
            payload["reason"] = "missing_trial_expiry"
            payload["status_reason"] = "missing_trial_expiry"
            return payload

        payload["remaining_days"] = _calculate_remaining_days(expires_at, now)
        payload["license_status"] = "trial_active" if expires_at > now else "trial_expired"
        payload["is_blocked"] = expires_at <= now
        payload["reason"] = "trial_expired" if expires_at <= now else None
        payload["status_reason"] = "trial_expired" if expires_at <= now else None
        raw["last_seen_local_at"] = _to_iso(now)
        raw["last_time_source"] = clock.source
        raw["last_time_reason"] = clock.reason
        raw["last_time_server"] = clock.server
        raw["last_time_trusted"] = clock.trusted
        if expires_at > now:
            raw["last_known_valid_at"] = _to_iso(now)
            raw["status_reason"] = None
        else:
            raw["status_reason"] = "trial_expired"
        save_license_state(raw)
        return payload

    activation_payload = str(raw.get("activation_payload") or "").strip()
    if not activation_payload:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "missing_activation_payload"
        payload["status_reason"] = "missing_activation_payload"
        return payload

    try:
        verified = _verify_activation_token(activation_payload)
    except HTTPException:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "activation_verification_failed"
        payload["status_reason"] = "activation_verification_failed"
        return payload

    verified_license_id = str(verified.get("license_id") or "").strip()
    if not verified_license_id:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "license_id_missing"
        payload["status_reason"] = "license_id_missing"
        return payload

    verified_sequence_number = _resolve_verified_sequence_number(verified, raw)
    payload["license_id"] = verified_license_id
    payload["sequence_number"] = verified_sequence_number
    payload["plan"] = verified.get("plan") or payload["plan"]
    payload["subscription_term"] = verified.get("subscription_term") or payload["subscription_term"]
    payload["expires_at"] = verified.get("expiry_date") or payload["expires_at"]
    payload["issued_at"] = verified.get("issue_date") or payload["issued_at"]
    payload["license_type"] = verified.get("license_type") or payload["license_type"] or "activation"

    if raw.get("license_id") and raw.get("license_id") != verified_license_id:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "local_state_tampered"
        payload["status_reason"] = "local_state_tampered"
        return payload

    if raw.get("sequence_number") and int(raw.get("sequence_number")) != verified_sequence_number:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "local_state_tampered"
        payload["status_reason"] = "local_state_tampered"
        return payload

    if store_id and verified.get("store_id") != store_id:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "store_mismatch"
        payload["status_reason"] = "store_mismatch"
        return payload

    if verified.get("installation_id") != installation_id:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "installation_mismatch"
        payload["status_reason"] = "installation_mismatch"
        return payload

    if verified_license_id not in set(raw.get("used_license_ids") or []):
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "local_state_tampered"
        payload["status_reason"] = "local_state_tampered"
        return payload

    expires_at = _from_iso(str(verified.get("expiry_date") or "").strip() or None)
    if str(payload["subscription_term"] or "").strip().lower() != LIFETIME_SUBSCRIPTION_TERM and not expires_at:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "missing_expiry_date"
        payload["status_reason"] = "missing_expiry_date"
        return payload

    payload["remaining_days"] = _calculate_remaining_days(expires_at, now)
    if expires_at and expires_at <= now:
        payload["license_status"] = "invalid"
        payload["is_blocked"] = True
        payload["reason"] = "license_expired"
        payload["status_reason"] = "license_expired"
        raw["status_reason"] = "license_expired"
        raw["last_seen_local_at"] = _to_iso(now)
        raw["last_time_source"] = clock.source
        raw["last_time_reason"] = clock.reason
        raw["last_time_server"] = clock.server
        raw["last_time_trusted"] = clock.trusted
        save_license_state(raw)
        return payload

    payload["license_status"] = "active"
    payload["is_blocked"] = False
    payload["reason"] = None
    payload["status_reason"] = None
    raw["sequence_number"] = verified_sequence_number
    raw["current_sequence_number"] = verified_sequence_number
    raw["status_reason"] = None
    raw["last_seen_local_at"] = _to_iso(now)
    raw["last_known_valid_at"] = _to_iso(now)
    raw["last_time_source"] = clock.source
    raw["last_time_reason"] = clock.reason
    raw["last_time_server"] = clock.server
    raw["last_time_trusted"] = clock.trusted
    save_license_state(raw)
    return payload


def activate_license(store_id: str, activation_key: str) -> dict[str, Any]:
    installation_id = resolve_installation_id()
    verified = _verify_activation_token(activation_key)
    state, integrity_issue = _load_state_with_integrity()

    if integrity_issue and state:
        raise HTTPException(409, "تم رصد عبث في بيانات الترخيص المحلية.")

    verified_store_id = str(verified.get("store_id") or "").strip()
    verified_installation_id = str(verified.get("installation_id") or "").strip()
    license_id = str(verified.get("license_id") or "").strip()
    sequence_number = _resolve_verified_sequence_number(verified, state)
    subscription_term = str(verified.get("subscription_term") or verified.get("plan") or "").strip().lower()
    plan = str(verified.get("plan") or "").strip() or "commercial"
    license_type = str(verified.get("license_type") or "").strip() or "subscription"

    if not license_id:
        raise HTTPException(400, "هذا الرمز لا يحتوي على معرف ترخيص.")
    if verified_store_id != store_id:
        raise HTTPException(400, "هذا الرمز مخصص لمتجر آخر.")
    if verified_installation_id != installation_id:
        raise HTTPException(400, "هذا الرمز مخصص لتثبيت آخر.")

    current_state = state or ensure_trial_initialized(store_id)
    used_ids = {str(item or "").strip() for item in current_state.get("used_license_ids") or [] if str(item or "").strip()}
    current_sequence_number = int(current_state.get("sequence_number") or 0)

    if license_id in used_ids:
        raise HTTPException(409, "هذا الرمز مستخدم مسبقًا.")
    if current_sequence_number and sequence_number <= current_sequence_number:
        raise HTTPException(409, "هذا الرمز أقدم من الترخيص الحالي.")

    expires_at = _from_iso(str(verified.get("expiry_date") or "").strip() or None)
    if subscription_term != LIFETIME_SUBSCRIPTION_TERM and not expires_at:
        raise HTTPException(400, "هذا الرمز لا يحتوي على تاريخ انتهاء صالح.")
    activation_clock = _license_clock(force_refresh=True)
    now = activation_clock.utc_now
    if expires_at and expires_at <= now:
        raise HTTPException(403, "انتهت صلاحية هذا الرمز قبل استخدامه.")

    next_state = _normalize_state(
        {
            "version": 2,
            "license_id": license_id,
            "sequence_number": sequence_number,
            "used_license_ids": sorted(used_ids | {license_id}),
            "store_id": store_id,
            "installation_id": installation_id,
            "license_type": license_type,
            "subscription_term": subscription_term or plan,
            "license_status": "active",
            "plan": plan,
            "trial_started_at": current_state.get("trial_started_at"),
            "trial_expires_at": current_state.get("trial_expires_at"),
            "activated_at": _to_iso(now),
            "issued_at": verified.get("issue_date"),
            "expires_at": verified.get("expiry_date"),
            "activation_payload": activation_key.strip(),
            "consumed_at": _to_iso(now),
            "last_seen_local_at": _to_iso(now),
            "last_known_valid_at": _to_iso(now),
            "status_reason": None,
            "previous_license_id": current_state.get("license_id"),
            "last_time_source": activation_clock.source,
            "last_time_reason": activation_clock.reason,
            "last_time_server": activation_clock.server,
            "last_time_trusted": activation_clock.trusted,
            "time_source": activation_clock.source,
            "time_sync_status": "trusted" if activation_clock.trusted else "fallback",
            "time_trusted": activation_clock.trusted,
            "time_reason": activation_clock.reason,
            "time_server": activation_clock.server,
            "time_offset_seconds": activation_clock.offset_seconds,
            "time_fetched_at": activation_clock.fetched_at.isoformat() if activation_clock.fetched_at else None,
        }
    )
    save_license_state(next_state)
    return evaluate_license_state(store_id)


def build_activation_request_url(
    *,
    store_name: str | None,
    store_type: str | None,
    country: str | None,
    currency: str | None,
    store_id: str | None,
    license_status: str | None,
) -> str:
    installation_id = resolve_installation_id()
    message = "\n".join(
        [
            f"طلب تفعيل {SYSTEM_BRAND_NAME}",
            f"اسم المتجر: {store_name or '-'}",
            f"نوع المتجر: {store_type or '-'}",
            f"الدولة: {country or '-'}",
            f"العملة: {currency or '-'}",
            f"store_id: {store_id or '-'}",
            f"installation_id: {installation_id}",
            f"الحالة الحالية: {license_status or 'pending'}",
        ]
    )
    return f"https://wa.me/{SUPPORT_WHATSAPP_NUMBER}?text={quote(message)}"


def get_public_license_summary(store_id: str | None = None) -> dict[str, Any]:
    payload = evaluate_license_state(store_id)
    return {
        "license_id": payload.get("license_id"),
        "sequence_number": payload.get("sequence_number"),
        "license_status": payload.get("license_status"),
        "license_type": payload.get("license_type"),
        "subscription_term": payload.get("subscription_term"),
        "trial_expires_at": payload.get("trial_expires_at"),
        "expires_at": payload.get("expires_at"),
        "remaining_days": payload.get("remaining_days"),
        "is_blocked": payload.get("is_blocked"),
        "reason": payload.get("reason"),
        "status_reason": payload.get("status_reason"),
        "consumed_at": payload.get("consumed_at"),
        "last_seen_local_at": payload.get("last_seen_local_at"),
        "current_time_utc": payload.get("current_time_utc"),
        "time_source": payload.get("time_source"),
        "time_sync_status": payload.get("time_sync_status"),
        "time_trusted": payload.get("time_trusted"),
        "time_reason": payload.get("time_reason"),
        "time_server": payload.get("time_server"),
    }


def should_block_usage() -> bool:
    if os.getenv("FLOWPOS_LAUNCHER_MODE", "host").strip().lower() == "client":
        return False
    payload = evaluate_license_state()
    return bool(payload.get("is_blocked") and payload.get("store_id"))
