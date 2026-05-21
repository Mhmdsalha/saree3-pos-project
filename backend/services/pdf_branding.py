from __future__ import annotations

import os

from reportlab.lib.units import mm
from reportlab.platypus import Image as PlatypusImage, Spacer, Table, TableStyle

from services.system_branding import get_system_logo_path


def build_branding_identity_parts(branding: dict | None = None) -> list[str]:
    payload = branding or {}
    parts: list[str] = []

    store_name = str(payload.get("store_name") or "").strip()
    store_phone = str(payload.get("phone") or "").strip()
    store_address = str(payload.get("address") or "").strip()

    if store_name:
        parts.append(store_name)
    if store_phone:
        parts.append(f"الهاتف: {store_phone}")
    if store_address:
        parts.append(store_address)

    return parts


def append_brand_logo(
    elements: list,
    branding: dict | None = None,
    *,
    width_mm: float = 30,
    height_mm: float = 30,
    spacer_mm: float = 4,
) -> bool:
    payload = branding or {}
    logo_path = str(payload.get("logo_path") or "").strip()
    store_logo = _build_logo_image(logo_path, width_mm=width_mm, height_mm=height_mm)
    system_logo_path = get_system_logo_path("dark")
    system_logo_width_mm = 36
    system_logo = _build_logo_image(
        str(system_logo_path) if system_logo_path else "",
        width_mm=system_logo_width_mm,
        height_mm=22,
    )

    if store_logo and system_logo:
        logos_table = Table([[store_logo, system_logo]], colWidths=[width_mm * mm, system_logo_width_mm * mm], hAlign="CENTER")
        logos_table.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("TOPPADDING", (0, 0), (-1, -1), 0),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                ]
            )
        )
        elements.extend([logos_table, Spacer(1, spacer_mm * mm)])
        return True

    if store_logo:
        store_logo.hAlign = "CENTER"
        elements.extend([store_logo, Spacer(1, spacer_mm * mm)])
        return True

    if system_logo:
        system_logo.hAlign = "CENTER"
        elements.extend([system_logo, Spacer(1, spacer_mm * mm)])
        return True

    return False


def _build_logo_image(logo_path: str, *, width_mm: float, height_mm: float):
    if not logo_path or not os.path.exists(logo_path):
        return None

    try:
        image = PlatypusImage(logo_path)
        max_width = width_mm * mm
        max_height = height_mm * mm
        ratio = min(max_width / image.imageWidth, max_height / image.imageHeight)
        image.drawWidth = image.imageWidth * ratio
        image.drawHeight = image.imageHeight * ratio
        return image
    except Exception:
        return None
