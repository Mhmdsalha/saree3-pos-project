from __future__ import annotations

from pathlib import Path
import sys


SYSTEM_BRAND_NAME = "سريع"
SYSTEM_BRAND_TAGLINE = "نظام نقاط البيع"


def _assets_root() -> Path:
    runtime_root = getattr(sys, "_MEIPASS", None)
    if runtime_root:
        return Path(runtime_root) / "assets"
    return Path(__file__).resolve().parent.parent / "assets"


def get_system_logo_path(variant: str = "dark") -> Path | None:
    normalized = "light" if str(variant or "").strip().lower() == "light" else "dark"
    candidate = _assets_root() / "branding" / f"system-logo-{normalized}.png"
    if candidate.exists() and candidate.is_file():
        return candidate
    return None
