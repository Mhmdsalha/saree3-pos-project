from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from html import escape
from io import BytesIO
import os
import re

import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from services.pdf_branding import append_brand_logo, build_branding_identity_parts
from services.timezone_service import to_local

_PDF_FONT_NAME = "InvoiceTahoma"
_PDF_FONT_CANDIDATES = [
    os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "tahoma.ttf"),
    os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "arial.ttf"),
]
_ARABIC_TEXT_RE = re.compile(r"[\u0600-\u06FF]")


def _rtl(value: str | int | float | None) -> str:
    text = str(value or "—")
    if not text or not _ARABIC_TEXT_RE.search(text):
        return text
    return get_display(arabic_reshaper.reshape(text))


def _paragraph(text: str | int | float | None, style: ParagraphStyle) -> Paragraph:
    return Paragraph(escape(_rtl(text)), style)


def _ensure_pdf_font() -> str:
    try:
        pdfmetrics.getFont(_PDF_FONT_NAME)
        return _PDF_FONT_NAME
    except KeyError:
        pass

    for candidate in _PDF_FONT_CANDIDATES:
        if os.path.exists(candidate):
            pdfmetrics.registerFont(TTFont(_PDF_FONT_NAME, candidate))
            return _PDF_FONT_NAME
    return "Helvetica"


def _styles(font_name: str) -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "InvoiceTitle",
            parent=base["Title"],
            fontName=font_name,
            fontSize=19,
            leading=23,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#0f172a"),
            spaceAfter=6,
        ),
        "subtitle": ParagraphStyle(
            "InvoiceSubtitle",
            parent=base["BodyText"],
            fontName=font_name,
            fontSize=9.5,
            leading=12,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#475569"),
            spaceAfter=10,
        ),
        "body": ParagraphStyle(
            "InvoiceBody",
            parent=base["BodyText"],
            fontName=font_name,
            fontSize=9,
            leading=12,
            alignment=TA_RIGHT,
            textColor=colors.HexColor("#0f172a"),
        ),
        "section": ParagraphStyle(
            "InvoiceSection",
            parent=base["Heading3"],
            fontName=font_name,
            fontSize=11,
            leading=14,
            alignment=TA_RIGHT,
            textColor=colors.HexColor("#0f172a"),
            spaceBefore=8,
            spaceAfter=6,
        ),
    }


def _format_quantity(item: dict) -> str:
    value = float(item.get("quantity") or 0)
    quantity = f"{value:.3f}".rstrip("0").rstrip(".")
    unit = str(item.get("product_unit") or "").strip()
    return f"{quantity} {unit}".strip()


def build_invoice_pdf(invoice: dict, branding: dict | None = None) -> bytes:
    font_name = _ensure_pdf_font()
    styles = _styles(font_name)
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=f"Invoice #{invoice['id']}",
    )

    created_at = invoice.get("created_at")
    if isinstance(created_at, str):
        try:
            created_at = datetime.fromisoformat(created_at)
        except ValueError:
            created_at = None

    localized_created_at = to_local(created_at)
    local_created = localized_created_at.strftime("%Y-%m-%d %H:%M") if localized_created_at else "—"

    branding = branding or {}
    currency_label = str(branding.get("currency") or "").strip() or "ر.س"

    info_rows = [
        [_paragraph(f"#{invoice['id']}", styles["body"]), _paragraph("رقم الفاتورة", styles["body"])],
        [_paragraph(local_created, styles["body"]), _paragraph("التاريخ", styles["body"])],
        [_paragraph(invoice.get("cashier_name") or "—", styles["body"]), _paragraph("الكاشير", styles["body"])],
        [_paragraph(invoice.get("customer_name") or "—", styles["body"]), _paragraph("العميل", styles["body"])],
        [_paragraph(invoice.get("customer_phone") or "—", styles["body"]), _paragraph("الهاتف", styles["body"])],
        [_paragraph(invoice.get("payment_method") or "—", styles["body"]), _paragraph("طريقة الدفع", styles["body"])],
    ]

    info_table = Table(info_rows, colWidths=[130 * mm, 40 * mm], hAlign="RIGHT")
    info_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
                ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )

    item_rows = [[
        _paragraph("الإجمالي", styles["body"]),
        _paragraph("السعر", styles["body"]),
        _paragraph("الكمية", styles["body"]),
        _paragraph("الصنف", styles["body"]),
        _paragraph("#", styles["body"]),
    ]]
    for index, item in enumerate(invoice.get("items") or [], start=1):
        item_rows.append(
            [
                _paragraph(f"{float(item.get('subtotal') or 0):.2f}", styles["body"]),
                _paragraph(f"{float(item.get('price') or 0):.2f}", styles["body"]),
                _paragraph(_format_quantity(item), styles["body"]),
                _paragraph(item.get("product_name") or f"#{item.get('product_id')}", styles["body"]),
                _paragraph(index, styles["body"]),
            ]
        )

    items_table = Table(item_rows, colWidths=[30 * mm, 25 * mm, 27 * mm, 76 * mm, 12 * mm], hAlign="RIGHT", repeatRows=1)
    items_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
                ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )

    total = Decimal(str(invoice.get("total") or 0)).quantize(Decimal("0.00"))
    discount = Decimal(str(invoice.get("discount") or 0)).quantize(Decimal("0.00"))
    final_total = Decimal(str(invoice.get("final_total") or 0)).quantize(Decimal("0.00"))

    summary_rows = [
        [_paragraph(f"{total:.2f} {currency_label}", styles["body"]), _paragraph("المجموع", styles["body"])],
        [_paragraph(f"{discount:.2f} {currency_label}", styles["body"]), _paragraph("الخصم", styles["body"])],
        [_paragraph(f"{final_total:.2f} {currency_label}", styles["body"]), _paragraph("الإجمالي النهائي", styles["body"])],
    ]
    summary_table = Table(summary_rows, colWidths=[55 * mm, 55 * mm], hAlign="RIGHT")
    summary_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fff7ed")),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#fdba74")),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#fed7aa")),
                ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )

    elements: list = []
    append_brand_logo(elements, branding)

    subtitle_parts = build_branding_identity_parts(branding)
    subtitle_parts.append("نسخة PDF مرسلة عبر تيليجرام")

    elements.extend([
        _paragraph("فاتورة المبيعات", styles["title"]),
        _paragraph(" • ".join(part for part in subtitle_parts if part), styles["subtitle"]),
        info_table,
        Spacer(1, 8),
        _paragraph("تفاصيل الأصناف", styles["section"]),
        items_table,
        Spacer(1, 8),
        summary_table,
    ])

    doc.build(elements)
    return buffer.getvalue()
