from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
from typing import Any

if os.name == "nt":
    import winreg


SECURE_STATE_FILE_NAME = "license-state.secure"
SUMMARY_STATE_FILE_NAME = "license-state.json"
REGISTRY_ROOT = r"Software\Saree\Launcher\License"
REGISTRY_BLOB_VALUE = "ProtectedState"
REGISTRY_FINGERPRINT_VALUE = "StateFingerprint"


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.c_uint32),
        ("pbData", ctypes.POINTER(ctypes.c_byte)),
    ]


crypt32 = ctypes.windll.crypt32 if os.name == "nt" else None
kernel32 = ctypes.windll.kernel32 if os.name == "nt" else None


def _secure_state_path(config_dir: Path) -> Path:
    return config_dir / SECURE_STATE_FILE_NAME


def _summary_state_path(config_dir: Path) -> Path:
    return config_dir / SUMMARY_STATE_FILE_NAME


def _canonical_json(state: dict[str, Any]) -> bytes:
    return json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _fingerprint(state: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(state)).hexdigest()


def _build_blob(raw: bytes) -> _DataBlob:
    buffer = ctypes.create_string_buffer(raw)
    blob = _DataBlob()
    blob.cbData = len(raw)
    blob.pbData = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))
    blob._buffer = buffer  # type: ignore[attr-defined]
    return blob


def _blob_to_bytes(blob: _DataBlob) -> bytes:
    if not blob.cbData:
        return b""
    pointer = ctypes.cast(blob.pbData, ctypes.POINTER(ctypes.c_ubyte))
    return bytes(pointer[index] for index in range(blob.cbData))


def _protect_bytes(raw: bytes) -> bytes:
    if os.name != "nt":
        return raw
    in_blob = _build_blob(raw)
    out_blob = _DataBlob()
    result = crypt32.CryptProtectData(
        ctypes.byref(in_blob),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(out_blob),
    )
    if not result:
        raise OSError("تعذر حماية بيانات الترخيص محليًا.")
    try:
        return _blob_to_bytes(out_blob)
    finally:
        if out_blob.pbData:
            kernel32.LocalFree(out_blob.pbData)


def _unprotect_bytes(raw: bytes) -> bytes:
    if os.name != "nt":
        return raw
    in_blob = _build_blob(raw)
    out_blob = _DataBlob()
    result = crypt32.CryptUnprotectData(
        ctypes.byref(in_blob),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(out_blob),
    )
    if not result:
        raise OSError("تعذر قراءة بيانات الترخيص المحمية.")
    try:
        return _blob_to_bytes(out_blob)
    finally:
        if out_blob.pbData:
            kernel32.LocalFree(out_blob.pbData)


def _write_registry_blob(protected_blob: bytes, fingerprint: str) -> None:
    if os.name != "nt":
        return
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGISTRY_ROOT) as key:
        winreg.SetValueEx(key, REGISTRY_BLOB_VALUE, 0, winreg.REG_BINARY, protected_blob)
        winreg.SetValueEx(key, REGISTRY_FINGERPRINT_VALUE, 0, winreg.REG_SZ, fingerprint)


def _read_registry_blob() -> tuple[bytes | None, str | None]:
    if os.name != "nt":
        return None, None
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_ROOT) as key:
            blob, _blob_type = winreg.QueryValueEx(key, REGISTRY_BLOB_VALUE)
            fingerprint, _fingerprint_type = winreg.QueryValueEx(key, REGISTRY_FINGERPRINT_VALUE)
            if isinstance(blob, bytes):
                return blob, str(fingerprint or "")
    except FileNotFoundError:
        return None, None
    return None, None


def clear_registry_blob() -> None:
    if os.name != "nt":
        return
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_ROOT, 0, winreg.KEY_SET_VALUE) as key:
            for value_name in (REGISTRY_BLOB_VALUE, REGISTRY_FINGERPRINT_VALUE):
                try:
                    winreg.DeleteValue(key, value_name)
                except FileNotFoundError:
                    pass
    except FileNotFoundError:
        return


def save_protected_license_state(config_dir: Path, state: dict[str, Any]) -> None:
    config_dir.mkdir(parents=True, exist_ok=True)
    canonical_state = json.loads(_canonical_json(state).decode("utf-8"))
    protected_blob = _protect_bytes(_canonical_json(canonical_state))
    fingerprint = _fingerprint(canonical_state)

    _secure_state_path(config_dir).write_bytes(protected_blob)
    _summary_state_path(config_dir).write_text(
        json.dumps(canonical_state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    _write_registry_blob(protected_blob, fingerprint)


def clear_protected_license_state(config_dir: Path) -> None:
    secure_path = _secure_state_path(config_dir)
    summary_path = _summary_state_path(config_dir)
    if secure_path.exists():
        secure_path.unlink()
    if summary_path.exists():
        summary_path.unlink()
    clear_registry_blob()


def _decode_protected_state(blob: bytes | None) -> dict[str, Any] | None:
    if not blob:
        return None
    raw = _unprotect_bytes(blob)
    payload = json.loads(raw.decode("utf-8"))
    return payload if isinstance(payload, dict) else None


def load_protected_license_state(config_dir: Path) -> tuple[dict[str, Any] | None, str | None]:
    secure_path = _secure_state_path(config_dir)

    file_blob = secure_path.read_bytes() if secure_path.exists() else None
    registry_blob, registry_fingerprint = _read_registry_blob()

    file_state: dict[str, Any] | None = None
    registry_state: dict[str, Any] | None = None
    file_error = False
    registry_error = False

    if file_blob is not None:
        try:
            file_state = _decode_protected_state(file_blob)
        except Exception:
            file_error = True
    if registry_blob is not None:
        try:
            registry_state = _decode_protected_state(registry_blob)
        except Exception:
            registry_error = True

    if file_state is None and registry_state is None:
        if file_error or registry_error:
            return None, "local_state_tampered"
        return None, None

    if file_state is not None and registry_state is not None:
        file_fingerprint = _fingerprint(file_state)
        registry_actual_fingerprint = _fingerprint(registry_state)
        if file_fingerprint == registry_actual_fingerprint == str(registry_fingerprint or registry_actual_fingerprint):
            return file_state, None
        return file_state, "local_state_tampered"

    surviving_state = file_state or registry_state
    return surviving_state, "local_state_tampered"
