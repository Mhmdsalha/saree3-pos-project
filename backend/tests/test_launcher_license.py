from __future__ import annotations

import base64
import json
import sys
import uuid
from datetime import datetime
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from fastapi import HTTPException

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import services.license_local_protection_service as local_protection
import services.license_service as license_service


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def _build_activation_token(private_key: ed25519.Ed25519PrivateKey, payload: dict) -> str:
    encoded_payload = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    signature = private_key.sign(encoded_payload)
    return f"FP1.{_b64url(encoded_payload)}.{_b64url(signature)}"


def _configure_test_env(monkeypatch, tmp_path, *, installation_id: str) -> None:
    monkeypatch.setenv("FLOWPOS_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("FLOWPOS_INSTALLATION_ID", installation_id)
    monkeypatch.setenv("FLOWPOS_TRUSTED_TIME_ENABLED", "0")
    monkeypatch.delenv("FLOWPOS_LICENSE_PRIVATE_KEY_B64", raising=False)
    monkeypatch.delenv("FLOWPOS_LICENSE_PRIVATE_KEY_FILE", raising=False)
    monkeypatch.setattr(
        local_protection,
        "REGISTRY_ROOT",
        rf"Software\Saree\Tests\License\{uuid.uuid4().hex}",
        raising=False,
    )
    local_protection.clear_registry_blob()


def _generate_keypair_and_public_b64() -> tuple[ed25519.Ed25519PrivateKey, str]:
    private_key = ed25519.Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return private_key, base64.b64encode(public_key).decode()


def _activation_payload(
    *,
    private_key: ed25519.Ed25519PrivateKey,
    store_id: str,
    installation_id: str,
    license_id: str,
    sequence_number: int,
    expiry_date: str | None,
    license_type: str = "subscription",
    subscription_term: str = "monthly",
    plan: str = "commercial",
    issue_date: str = "2026-04-22T12:00:00",
) -> str:
    payload = {
        "license_id": license_id,
        "sequence_number": sequence_number,
        "store_id": store_id,
        "installation_id": installation_id,
        "license_type": license_type,
        "subscription_term": subscription_term,
        "plan": plan,
        "issue_date": issue_date,
    }
    if expiry_date:
        payload["expiry_date"] = expiry_date
    return _build_activation_token(private_key, payload)


def _seed_subscription_state(
    *,
    store_id: str,
    installation_id: str,
    activation_key: str,
    license_id: str,
    sequence_number: int,
    expires_at: str | None,
    last_seen_local_at: str = "2026-05-03T12:00:00",
    last_known_valid_at: str = "2026-05-03T12:00:00",
) -> None:
    license_service.save_license_state(
        {
            "version": 2,
            "license_id": license_id,
            "sequence_number": sequence_number,
            "used_license_ids": [license_id],
            "store_id": store_id,
            "installation_id": installation_id,
            "license_type": "subscription",
            "subscription_term": "monthly",
            "license_status": "active",
            "plan": "commercial",
            "trial_started_at": None,
            "trial_expires_at": None,
            "activated_at": "2026-04-22T12:00:00",
            "issued_at": "2026-04-22T12:00:00",
            "expires_at": expires_at,
            "activation_payload": activation_key,
            "consumed_at": "2026-04-22T12:00:00",
            "last_seen_local_at": last_seen_local_at,
            "last_known_valid_at": last_known_valid_at,
            "status_reason": None,
        }
    )


def test_trial_initializes_for_host_store(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-test-001")

    license_service.ensure_trial_initialized("store-demo-1")
    payload = license_service.evaluate_license_state("store-demo-1")

    assert payload["store_id"] == "store-demo-1"
    assert payload["installation_id"] == "inst-test-001"
    assert payload["license_status"] == "trial_active"
    assert payload["is_blocked"] is False
    assert payload["trial_expires_at"]

    secure_path = Path(tmp_path / "config" / local_protection.SECURE_STATE_FILE_NAME)
    registry_blob, _registry_fingerprint = local_protection._read_registry_blob()
    assert secure_path.exists()
    assert registry_blob


def test_trial_expired_blocks_host(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-trial-expired")

    license_service.ensure_trial_initialized("store-trial-expired")
    state = license_service.load_license_state()
    assert state is not None
    state["trial_expires_at"] = "2026-05-01T00:00:00"
    state["last_seen_local_at"] = "2026-05-01T00:00:00"
    state["last_known_valid_at"] = "2026-05-01T00:00:00"
    license_service.save_license_state(state)

    payload = license_service.evaluate_license_state("store-trial-expired")

    assert payload["license_status"] == "trial_expired"
    assert payload["is_blocked"] is True
    assert payload["reason"] == "trial_expired"
    assert payload["status_reason"] == "trial_expired"


def test_activation_key_is_verified_locally(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-test-activation")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    license_service.ensure_trial_initialized("store-demo-2")
    token = _activation_payload(
        private_key=private_key,
        store_id="store-demo-2",
        installation_id="inst-test-activation",
        license_id="lic-activation-001",
        sequence_number=1,
        expiry_date="2026-06-22T12:00:00",
    )

    payload = license_service.activate_license("store-demo-2", token)
    state = license_service.load_license_state()

    assert payload["license_status"] == "active"
    assert payload["sequence_number"] == 1
    assert payload["license_id"] == "lic-activation-001"
    assert state is not None
    assert state["license_id"] == "lic-activation-001"
    assert state["sequence_number"] == 1
    assert "lic-activation-001" in state["used_license_ids"]


def test_activation_key_accepts_any_configured_public_key(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-multi-key")
    private_key, valid_public_key_b64 = _generate_keypair_and_public_b64()
    _unused_private_key, unused_public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", f"{unused_public_key_b64},{valid_public_key_b64}")

    license_service.ensure_trial_initialized("store-multi-key")
    token = _activation_payload(
        private_key=private_key,
        store_id="store-multi-key",
        installation_id="inst-multi-key",
        license_id="lic-multi-key-001",
        sequence_number=1,
        expiry_date="2026-06-22T12:00:00",
    )

    payload = license_service.activate_license("store-multi-key", token)

    assert payload["license_status"] == "active"
    assert payload["license_id"] == "lic-multi-key-001"


def test_activation_key_rejects_other_store(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-store-mismatch")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    token = _activation_payload(
        private_key=private_key,
        store_id="store-other",
        installation_id="inst-store-mismatch",
        license_id="lic-store-mismatch",
        sequence_number=1,
        expiry_date="2026-06-22T12:00:00",
    )

    with pytest.raises(HTTPException) as exc_info:
        license_service.activate_license("store-demo-3", token)

    assert exc_info.value.status_code == 400
    assert "متجر آخر" in str(exc_info.value.detail)


def test_activation_key_rejects_other_installation(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-correct")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    token = _activation_payload(
        private_key=private_key,
        store_id="store-demo-4",
        installation_id="inst-other",
        license_id="lic-install-mismatch",
        sequence_number=1,
        expiry_date="2026-06-22T12:00:00",
    )

    with pytest.raises(HTTPException) as exc_info:
        license_service.activate_license("store-demo-4", token)

    assert exc_info.value.status_code == 400
    assert "تثبيت آخر" in str(exc_info.value.detail)


def test_activation_key_rejects_invalid_signature(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-invalid-signature")

    signing_private_key, _ = _generate_keypair_and_public_b64()
    _verification_private_key, verification_public_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", verification_public_b64)

    token = _activation_payload(
        private_key=signing_private_key,
        store_id="store-demo-5",
        installation_id="inst-invalid-signature",
        license_id="lic-invalid-signature",
        sequence_number=1,
        expiry_date="2026-06-22T12:00:00",
    )

    with pytest.raises(HTTPException) as exc_info:
        license_service.activate_license("store-demo-5", token)

    assert exc_info.value.status_code == 400


def test_same_license_id_is_rejected_on_second_activation(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-reuse")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    token = _activation_payload(
        private_key=private_key,
        store_id="store-demo-6",
        installation_id="inst-reuse",
        license_id="lic-reuse-001",
        sequence_number=1,
        expiry_date="2026-06-22T12:00:00",
    )

    license_service.activate_license("store-demo-6", token)

    with pytest.raises(HTTPException) as exc_info:
        license_service.activate_license("store-demo-6", token)

    assert exc_info.value.status_code == 409
    assert "مستخدم مسبقًا" in str(exc_info.value.detail)


def test_older_or_equal_sequence_is_rejected(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-sequence")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    token_v1 = _activation_payload(
        private_key=private_key,
        store_id="store-demo-7",
        installation_id="inst-sequence",
        license_id="lic-seq-001",
        sequence_number=2,
        expiry_date="2026-06-22T12:00:00",
    )
    license_service.activate_license("store-demo-7", token_v1)

    token_v2 = _activation_payload(
        private_key=private_key,
        store_id="store-demo-7",
        installation_id="inst-sequence",
        license_id="lic-seq-002",
        sequence_number=2,
        expiry_date="2026-07-22T12:00:00",
    )

    with pytest.raises(HTTPException) as exc_info:
        license_service.activate_license("store-demo-7", token_v2)

    assert exc_info.value.status_code == 409
    assert "أقدم من الترخيص الحالي" in str(exc_info.value.detail)


def test_higher_sequence_is_accepted(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-renew")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    token_v1 = _activation_payload(
        private_key=private_key,
        store_id="store-demo-8",
        installation_id="inst-renew",
        license_id="lic-renew-001",
        sequence_number=1,
        expiry_date="2026-06-22T12:00:00",
    )
    token_v2 = _activation_payload(
        private_key=private_key,
        store_id="store-demo-8",
        installation_id="inst-renew",
        license_id="lic-renew-002",
        sequence_number=2,
        expiry_date="2026-07-22T12:00:00",
    )

    license_service.activate_license("store-demo-8", token_v1)
    payload = license_service.activate_license("store-demo-8", token_v2)
    state = license_service.load_license_state()

    assert payload["license_status"] == "active"
    assert payload["sequence_number"] == 2
    assert state is not None
    assert state["license_id"] == "lic-renew-002"
    assert state["sequence_number"] == 2
    assert sorted(state["used_license_ids"]) == ["lic-renew-001", "lic-renew-002"]


def test_expired_subscription_blocks(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-expired")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    token = _activation_payload(
        private_key=private_key,
        store_id="store-expired",
        installation_id="inst-expired",
        license_id="lic-expired-001",
        sequence_number=1,
        expiry_date="2026-05-01T00:00:00",
    )
    _seed_subscription_state(
        store_id="store-expired",
        installation_id="inst-expired",
        activation_key=token,
        license_id="lic-expired-001",
        sequence_number=1,
        expires_at="2026-05-01T00:00:00",
    )

    payload = license_service.evaluate_license_state("store-expired")

    assert payload["license_status"] == "invalid"
    assert payload["is_blocked"] is True
    assert payload["status_reason"] == "license_expired"


def test_activation_rejects_expired_token_using_trusted_clock(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-trusted-expired")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)
    monkeypatch.setattr(
        license_service,
        "_license_clock",
        lambda force_refresh=False: license_service.TrustedTimeSnapshot(
            utc_now=datetime.fromisoformat("2026-05-10T00:00:00"),
            source="ntp",
            trusted=True,
            reason=None,
            server="pool.ntp.org",
            offset_seconds=0.0,
            fetched_at=datetime.fromisoformat("2026-05-10T00:00:00"),
        ),
    )

    token = _activation_payload(
        private_key=private_key,
        store_id="store-trusted-expired",
        installation_id="inst-trusted-expired",
        license_id="lic-trusted-expired-001",
        sequence_number=1,
        expiry_date="2026-05-01T00:00:00",
    )

    with pytest.raises(HTTPException) as exc_info:
        license_service.activate_license("store-trusted-expired", token)

    assert exc_info.value.status_code == 403


def test_clock_rollback_sets_status_reason(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-clock")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    token = _activation_payload(
        private_key=private_key,
        store_id="store-clock",
        installation_id="inst-clock",
        license_id="lic-clock-001",
        sequence_number=1,
        expiry_date="2026-06-22T12:00:00",
    )
    _seed_subscription_state(
        store_id="store-clock",
        installation_id="inst-clock",
        activation_key=token,
        license_id="lic-clock-001",
        sequence_number=1,
        expires_at="2026-06-22T12:00:00",
        last_seen_local_at="2026-12-01T00:00:00",
        last_known_valid_at="2026-12-01T00:00:00",
    )

    payload = license_service.evaluate_license_state("store-clock")

    assert payload["license_status"] == "invalid"
    assert payload["is_blocked"] is True
    assert payload["status_reason"] == "clock_rollback_suspected"


def test_missing_one_protected_source_detects_tampering(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-tamper")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    token = _activation_payload(
        private_key=private_key,
        store_id="store-tamper",
        installation_id="inst-tamper",
        license_id="lic-tamper-001",
        sequence_number=1,
        expiry_date="2026-06-22T12:00:00",
    )
    license_service.activate_license("store-tamper", token)

    secure_path = Path(tmp_path / "config" / local_protection.SECURE_STATE_FILE_NAME)
    secure_path.unlink()

    payload = license_service.evaluate_license_state("store-tamper")

    assert payload["license_status"] == "invalid"
    assert payload["is_blocked"] is True
    assert payload["status_reason"] == "local_state_tampered"


def test_legacy_active_license_without_sequence_number_is_migrated(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-legacy")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    legacy_token = _build_activation_token(
        private_key,
        {
            "license_id": "lic-legacy-001",
            "store_id": "store-legacy",
            "installation_id": "inst-legacy",
            "license_type": "subscription",
            "subscription_term": "monthly",
            "plan": "commercial",
            "issue_date": "2026-04-22T12:00:00",
            "expiry_date": "2026-06-22T12:00:00",
        },
    )
    license_service.save_license_state(
        {
            "version": 1,
            "license_id": "lic-legacy-001",
            "used_license_ids": ["lic-legacy-001"],
            "store_id": "store-legacy",
            "installation_id": "inst-legacy",
            "license_type": "subscription",
            "subscription_term": "monthly",
            "license_status": "active",
            "plan": "commercial",
            "activated_at": "2026-04-22T12:00:00",
            "issued_at": "2026-04-22T12:00:00",
            "expires_at": "2026-06-22T12:00:00",
            "activation_payload": legacy_token,
            "consumed_at": "2026-04-22T12:00:00",
            "last_seen_local_at": "2026-05-03T12:00:00",
            "last_known_valid_at": "2026-05-03T12:00:00",
            "status_reason": None,
        }
    )

    payload = license_service.evaluate_license_state("store-legacy")
    state = license_service.load_license_state()

    assert payload["license_status"] == "active"
    assert payload["is_blocked"] is False
    assert payload["sequence_number"] == 1
    assert state is not None
    assert state["sequence_number"] == 1


def test_legacy_token_without_sequence_number_can_activate_from_trial(monkeypatch, tmp_path):
    _configure_test_env(monkeypatch, tmp_path, installation_id="inst-legacy-trial")
    private_key, public_key_b64 = _generate_keypair_and_public_b64()
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", public_key_b64)

    license_service.ensure_trial_initialized("store-legacy-trial")
    legacy_token = _build_activation_token(
        private_key,
        {
            "license_id": "lic-legacy-trial-001",
            "store_id": "store-legacy-trial",
            "installation_id": "inst-legacy-trial",
            "license_type": "subscription",
            "subscription_term": "quarterly",
            "plan": "quarterly",
            "issue_date": "2026-05-05T18:36:51",
            "expiry_date": "2026-08-05T18:36:51",
        },
    )

    payload = license_service.activate_license("store-legacy-trial", legacy_token)
    state = license_service.load_license_state()

    assert payload["license_status"] == "active"
    assert payload["sequence_number"] == 1
    assert state is not None
    assert state["sequence_number"] == 1
    assert state["license_id"] == "lic-legacy-trial-001"
