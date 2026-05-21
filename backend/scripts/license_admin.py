from __future__ import annotations

import argparse
import calendar
import json
import secrets
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from services.license_service import build_activation_token, decode_activation_token_payload, generate_license_keypair_b64

DEFAULT_ADMIN_KEY_DIR = (Path.home() / ".saree-license-admin").resolve()
DEFAULT_PRIVATE_KEY_FILE = DEFAULT_ADMIN_KEY_DIR / "flowpos-license-private.b64"
DEFAULT_ISSUED_LICENSES_FILE = DEFAULT_ADMIN_KEY_DIR / "issued-licenses.json"
DEFAULT_SEQUENCE_FILE = DEFAULT_ADMIN_KEY_DIR / "license-sequence.txt"

SUBSCRIPTION_TERMS = {
    "lifetime": {"license_type": "lifetime", "plan": "lifetime", "months": None},
    "monthly": {"license_type": "subscription", "plan": "monthly", "months": 1},
    "quarterly": {"license_type": "subscription", "plan": "quarterly", "months": 3},
    "semiannual": {"license_type": "subscription", "plan": "semiannual", "months": 6},
    "yearly": {"license_type": "subscription", "plan": "yearly", "months": 12},
}


def _parse_issue_date(value: str | None) -> datetime:
    raw = (value or "").strip()
    if not raw:
        return datetime.now().replace(microsecond=0)
    return datetime.fromisoformat(raw)


def _add_months(value: datetime, months: int) -> datetime:
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def resolve_subscription_term(subscription_term: str, issue_date: str | None = None) -> tuple[str, str, str, str | None]:
    term = str(subscription_term or "").strip().lower()
    if term not in SUBSCRIPTION_TERMS:
        raise ValueError("نوع الاشتراك غير صالح.")

    config = SUBSCRIPTION_TERMS[term]
    issued_at = _parse_issue_date(issue_date)
    months = config["months"]
    expiry_date = _add_months(issued_at, months).isoformat(timespec="seconds") if months else None
    return config["license_type"], config["plan"], issued_at.isoformat(timespec="seconds"), expiry_date


def _read_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8").strip()


def _ensure_admin_dir() -> None:
    DEFAULT_ADMIN_KEY_DIR.mkdir(parents=True, exist_ok=True)


def _load_sequence_counter() -> int:
    _ensure_admin_dir()
    if not DEFAULT_SEQUENCE_FILE.exists():
        return 0
    try:
        return max(0, int(DEFAULT_SEQUENCE_FILE.read_text(encoding="utf-8").strip() or "0"))
    except Exception:
        return 0


def _save_sequence_counter(value: int) -> None:
    _ensure_admin_dir()
    DEFAULT_SEQUENCE_FILE.write_text(str(max(0, int(value))), encoding="utf-8")


def _resolve_sequence_number(sequence_number: int | None) -> int:
    if sequence_number is not None:
        if int(sequence_number) <= 0:
            raise ValueError("يجب أن يكون sequence_number رقمًا موجبًا.")
        current = _load_sequence_counter()
        if int(sequence_number) > current:
            _save_sequence_counter(int(sequence_number))
        return int(sequence_number)

    next_value = _load_sequence_counter() + 1
    _save_sequence_counter(next_value)
    return next_value


def _load_issued_licenses() -> dict[str, Any]:
    _ensure_admin_dir()
    if not DEFAULT_ISSUED_LICENSES_FILE.exists():
        return {"licenses": []}
    try:
        payload = json.loads(DEFAULT_ISSUED_LICENSES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"licenses": []}
    if not isinstance(payload, dict) or not isinstance(payload.get("licenses"), list):
        return {"licenses": []}
    return payload


def _save_issued_licenses(payload: dict[str, Any]) -> None:
    _ensure_admin_dir()
    DEFAULT_ISSUED_LICENSES_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _upsert_issued_license(record: dict[str, Any]) -> None:
    payload = _load_issued_licenses()
    licenses = payload["licenses"]
    license_id = str(record.get("license_id") or "").strip()
    for index, existing in enumerate(licenses):
        if str(existing.get("license_id") or "").strip() == license_id:
            licenses[index] = record
            _save_issued_licenses(payload)
            return
    licenses.append(record)
    _save_issued_licenses(payload)


def _get_issued_license(license_id: str) -> dict[str, Any] | None:
    payload = _load_issued_licenses()
    for record in payload["licenses"]:
        if str(record.get("license_id") or "").strip() == license_id:
            return record
    return None


def issue_license_token(
    *,
    private_key_b64: str,
    store_id: str,
    installation_id: str,
    sequence_number: int,
    license_type: str,
    plan: str,
    subscription_term: str | None = None,
    issue_date: str | None = None,
    expiry_date: str | None = None,
    previous_license_id: str | None = None,
) -> str:
    resolved_issue_date = issue_date or datetime.now().isoformat(timespec="seconds")
    resolved_license_type = license_type
    resolved_plan = plan
    resolved_expiry_date = expiry_date
    resolved_term = subscription_term

    if subscription_term:
        resolved_license_type, resolved_plan, resolved_issue_date, resolved_expiry_date = resolve_subscription_term(subscription_term, issue_date)

    license_id = f"lic-{secrets.token_hex(10)}"
    payload: dict[str, Any] = {
        "license_id": license_id,
        "sequence_number": int(sequence_number),
        "store_id": store_id,
        "installation_id": installation_id,
        "license_type": resolved_license_type,
        "subscription_term": resolved_term or resolved_plan,
        "plan": resolved_plan,
        "issue_date": resolved_issue_date,
    }
    if resolved_expiry_date:
        payload["expiry_date"] = resolved_expiry_date
    if previous_license_id:
        payload["previous_license_id"] = previous_license_id
    return build_activation_token(private_key_b64, payload)


def issue_license_package(
    *,
    private_key_b64: str | None = None,
    store_id: str,
    installation_id: str,
    license_type: str,
    plan: str,
    subscription_term: str | None = None,
    issue_date: str | None = None,
    expiry_date: str | None = None,
    sequence_number: int | None = None,
    previous_license_id: str | None = None,
) -> dict[str, Any]:
    private_key_value = private_key_b64 or ""
    if not private_key_value and DEFAULT_PRIVATE_KEY_FILE.exists():
        private_key_value = _read_text(str(DEFAULT_PRIVATE_KEY_FILE))
    if not private_key_value:
        raise RuntimeError("يجب تمرير المفتاح الخاص أو توفيره في ~/.saree-license-admin")

    resolved_sequence_number = _resolve_sequence_number(sequence_number)
    token = issue_license_token(
        private_key_b64=private_key_value,
        store_id=store_id,
        installation_id=installation_id,
        sequence_number=resolved_sequence_number,
        subscription_term=subscription_term,
        license_type=license_type,
        plan=plan,
        issue_date=issue_date,
        expiry_date=expiry_date,
        previous_license_id=previous_license_id,
    )
    payload = decode_activation_token_payload(token)
    package = {
        "license_id": str(payload.get("license_id") or "").strip(),
        "sequence_number": int(payload.get("sequence_number") or resolved_sequence_number),
        "activation_key": token,
        "payload": payload,
    }
    _upsert_issued_license(
        {
            **package,
            "store_id": store_id,
            "installation_id": installation_id,
            "subscription_term": subscription_term,
            "license_type": payload.get("license_type"),
            "plan": payload.get("plan"),
            "issue_date": payload.get("issue_date"),
            "expiry_date": payload.get("expiry_date"),
            "previous_license_id": payload.get("previous_license_id"),
            "status": "issued",
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "revoked_at": None,
            "revocation_reason": None,
        }
    )
    return package


def get_license_details(license_id: str) -> dict[str, Any]:
    resolved_license_id = str(license_id or "").strip()
    if not resolved_license_id:
        raise ValueError("يجب تمرير license_id.")
    record = _get_issued_license(resolved_license_id)
    if not record:
        raise RuntimeError("الترخيص غير موجود.")
    return record


def revoke_license(license_id: str, reason: str | None = None) -> dict[str, Any]:
    record = get_license_details(license_id)
    updated_record = {
        **record,
        "status": "revoked",
        "revoked_at": datetime.now().isoformat(timespec="seconds"),
        "revocation_reason": reason or "manual_revoke",
    }
    _upsert_issued_license(updated_record)
    return updated_record


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Saree offline activation administration tool.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    keygen = subparsers.add_parser("generate-keypair", help="Generate an Ed25519 keypair for activation signing.")
    keygen.add_argument("--out-dir", default="", help="Optional output directory to save the generated keys.")
    keygen.add_argument("--prefix", default="flowpos-license", help="File prefix when saving generated keys.")

    issue = subparsers.add_parser("issue-license", help="Issue a signed activation token locally.")
    issue.add_argument("--private-key-b64", default="", help="Raw Ed25519 private key in base64.")
    issue.add_argument("--private-key-file", default="", help="Path to a text file containing the base64 private key.")
    issue.add_argument("--store-id", required=True, help="Target store_id.")
    issue.add_argument("--installation-id", required=True, help="Target installation_id.")
    issue.add_argument("--subscription-term", default="", choices=["", "lifetime", "monthly", "quarterly", "semiannual", "yearly"], help="Optional commercial subscription preset.")
    issue.add_argument("--license-type", default="lifetime", help="License type value embedded in the token.")
    issue.add_argument("--plan", default="commercial", help="Commercial plan value embedded in the token.")
    issue.add_argument("--issue-date", default="", help="ISO issue date override.")
    issue.add_argument("--expiry-date", default="", help="Optional ISO expiry date.")
    issue.add_argument("--sequence-number", type=int, default=None, help="Optional renewal sequence number. If omitted, a local counter is used.")
    issue.add_argument("--previous-license-id", default="", help="Optional previous license_id for renewal traceability.")
    issue.add_argument("--output", default="", help="Optional file path to write the generated token.")
    issue.add_argument("--json", action="store_true", help="Print the full issue package as JSON.")

    revoke = subparsers.add_parser("revoke-license", help="Mark an issued license as revoked locally.")
    revoke.add_argument("--license-id", required=True, help="Target license_id.")
    revoke.add_argument("--reason", default="", help="Optional revocation reason.")

    get_license = subparsers.add_parser("get-license", help="Fetch a locally issued license record by license_id.")
    get_license.add_argument("--license-id", required=True, help="Target license_id.")

    inspect = subparsers.add_parser("inspect-token", help="Decode the payload of an activation token.")
    inspect.add_argument("--token", required=True, help="Activation token to inspect.")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "generate-keypair":
            private_key_b64, public_key_b64 = generate_license_keypair_b64()
            if args.out_dir:
                out_dir = Path(args.out_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                private_path = out_dir / f"{args.prefix}-private.b64"
                public_path = out_dir / f"{args.prefix}-public.b64"
                private_path.write_text(private_key_b64, encoding="utf-8")
                public_path.write_text(public_key_b64, encoding="utf-8")
                print(json.dumps({"private_key_file": str(private_path), "public_key_file": str(public_path)}, ensure_ascii=False, indent=2))
            else:
                print(json.dumps({"private_key_b64": private_key_b64, "public_key_b64": public_key_b64}, ensure_ascii=False, indent=2))
            return 0

        if args.command == "issue-license":
            private_key_b64 = args.private_key_b64 or (_read_text(args.private_key_file) if args.private_key_file else "")
            if not private_key_b64 and DEFAULT_PRIVATE_KEY_FILE.exists():
                private_key_b64 = _read_text(str(DEFAULT_PRIVATE_KEY_FILE))

            package = issue_license_package(
                private_key_b64=private_key_b64 or None,
                store_id=args.store_id,
                installation_id=args.installation_id,
                subscription_term=args.subscription_term or None,
                license_type=args.license_type,
                plan=args.plan,
                issue_date=args.issue_date or None,
                expiry_date=args.expiry_date or None,
                sequence_number=args.sequence_number,
                previous_license_id=args.previous_license_id or None,
            )
            if args.output:
                Path(args.output).write_text(package["activation_key"], encoding="utf-8")
            if args.json:
                print(json.dumps(package, ensure_ascii=False, indent=2))
            else:
                print(package["activation_key"])
            return 0

        if args.command == "revoke-license":
            result = revoke_license(args.license_id, reason=args.reason or None)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0

        if args.command == "get-license":
            result = get_license_details(args.license_id)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0

        if args.command == "inspect-token":
            payload = decode_activation_token_payload(args.token)
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 0

        parser.error("الأمر غير معروف")
        return 1
    except Exception as exc:
        parser.error(str(exc))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
