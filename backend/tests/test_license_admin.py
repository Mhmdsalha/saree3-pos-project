import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519


def test_issue_license_token_is_accepted_by_license_service(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOWPOS_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FLOWPOS_INSTALLATION_ID", "inst-admin-script")

    private_key = ed25519.Ed25519PrivateKey.generate()
    private_key_b64 = base64.b64encode(
        private_key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
    ).decode()
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    monkeypatch.setenv("FLOWPOS_LICENSE_PUBLIC_KEY_B64", base64.b64encode(public_key).decode())

    from scripts.license_admin import issue_license_token
    from services.license_service import activate_license, ensure_trial_initialized

    ensure_trial_initialized("store-admin-1")
    token = issue_license_token(
        private_key_b64=private_key_b64,
        store_id="store-admin-1",
        installation_id="inst-admin-script",
        license_type="lifetime",
        plan="pro",
        issue_date="2026-05-02T12:00:00",
    )

    payload = activate_license("store-admin-1", token)
    assert payload["license_status"] == "active"
    assert payload["license_type"] == "lifetime"
    assert payload["plan"] == "pro"


def test_generate_keypair_and_decode_token_payload():
    from scripts.license_admin import issue_license_token
    from services.license_service import decode_activation_token_payload, generate_license_keypair_b64

    private_key_b64, _public_key_b64 = generate_license_keypair_b64()
    token = issue_license_token(
        private_key_b64=private_key_b64,
        store_id="store-admin-2",
        installation_id="inst-admin-2",
        license_type="subscription",
        plan="advanced",
        issue_date="2026-05-02T15:30:00",
        expiry_date="2027-05-02T15:30:00",
    )

    payload = decode_activation_token_payload(token)
    assert payload["store_id"] == "store-admin-2"
    assert payload["installation_id"] == "inst-admin-2"
    assert payload["license_type"] == "subscription"
    assert payload["expiry_date"] == "2027-05-02T15:30:00"


def test_subscription_term_preset_sets_expected_expiry():
    from scripts.license_admin import issue_license_token
    from services.license_service import decode_activation_token_payload, generate_license_keypair_b64

    private_key_b64, _public_key_b64 = generate_license_keypair_b64()
    token = issue_license_token(
        private_key_b64=private_key_b64,
        store_id="store-admin-3",
        installation_id="inst-admin-3",
        subscription_term="quarterly",
        license_type="subscription",
        plan="commercial",
        issue_date="2026-05-02T15:30:00",
    )

    payload = decode_activation_token_payload(token)
    assert payload["subscription_term"] == "quarterly"
    assert payload["plan"] == "quarterly"
    assert payload["expiry_date"] == "2026-08-02T15:30:00"
