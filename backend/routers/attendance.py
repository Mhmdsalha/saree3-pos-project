"""router: /attendance/*"""
import calendar
from datetime import datetime, timedelta
from html import escape
from io import BytesIO
import os
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
import arabic_reshaper
from bidi.algorithm import get_display

from database import get_db
from models import User, Session as CashierSession
from routers.deps import require_manager
from services.launcher_service import get_store_branding
from services.pdf_branding import append_brand_logo, build_branding_identity_parts
from services.system_settings_service import format_workday_hours_label, get_workday_hours_setting
from services.timezone_service import local_day_range, local_iso, local_month_range, local_now, to_local, utc_now

router = APIRouter(prefix="/attendance", tags=["attendance"])

_ONLINE_TIMEOUT_SECONDS = 300
_PDF_FONT_NAME = "AttendanceTahoma"
_PDF_FONT_CANDIDATES = [
    os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "tahoma.ttf"),
    os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "arial.ttf"),
]
_ARABIC_TEXT_RE = re.compile(r"[\u0600-\u06FF]")

def get_month_boundaries(year: int, month: int):
    return local_month_range(f"{year:04d}-{month:02d}")

def session_last_seen(session: CashierSession):
    return session.last_activity_at or session.opened_at

def session_is_stale(session: CashierSession, now: datetime | None = None) -> bool:
    if not session.is_active:
        return False
    last_seen = session_last_seen(session)
    if not last_seen:
        return False
    now = now or utc_now()
    return (now - last_seen).total_seconds() > _ONLINE_TIMEOUT_SECONDS

def role_label(role: str | None) -> str:
    labels = {"admin": "مدير", "supervisor": "مشرف", "cashier": "كاشير"}
    return labels.get(role or "", role or "—")

def status_label(status: str | None) -> str:
    return "متصل" if status == "online" else "غير متصل"

def format_iso_local_time(value: str | None) -> str:
    if not value:
        return "—"
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return "—"
    return dt.strftime("%H:%M")

def format_hours_value(hours: float | int | None) -> str:
    total_minutes = int(round(float(hours or 0) * 60))
    hh, mm = divmod(total_minutes, 60)
    if hh and mm:
        return f"{hh} ساعة {mm} دقيقة"
    if hh:
        return f"{hh} ساعة"
    return f"{mm} دقيقة"

def is_qualified_workday(hours: float | int | None, workday_hours: float) -> bool:
    return float(hours or 0) >= float(workday_hours or 0)

def overtime_hours_value(hours: float | int | None, workday_hours: float) -> float:
    return round(max(0.0, float(hours or 0) - float(workday_hours or 0)), 2)

def validate_year_month(year: int, month: int) -> tuple[int, int]:
    year = int(year)
    month = int(month)
    if year < 2000 or year > 2100:
        raise HTTPException(400, "السنة غير صالحة")
    if month < 1 or month > 12:
        raise HTTPException(400, "الشهر غير صالح")
    return year, month

def format_period_label(start_iso: str | None, end_iso: str | None) -> str:
    start = format_iso_local_time(start_iso)
    end = format_iso_local_time(end_iso)
    if start == "—" and end == "—":
        return "—"
    return f"{start} → {end}"

def day_status_label(day: dict, workday_hours: float) -> str:
    has_hours = float(day.get("hours") or 0) > 0
    if is_qualified_workday(day.get("hours"), workday_hours):
        return "مكتمل"
    if has_hours:
        return "جزئي"
    return "لا يوجد اتصال"

def pdf_rtl_text(value: str | int | float | None) -> str:
    text = str(value or "—")
    if not text or not _ARABIC_TEXT_RE.search(text):
        return text
    return get_display(arabic_reshaper.reshape(text))

def pdf_paragraph(text: str | int | float | None, style: ParagraphStyle) -> Paragraph:
    return Paragraph(escape(pdf_rtl_text(text)), style)

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

def build_pdf_caption(scope: str, year: int, month: int, employee_name: str | None = None) -> str:
    month_label = f"{year}-{month:02d}"
    if scope == "employee" and employee_name:
        return f"تقرير حضور الموظف {employee_name} لشهر {month_label}"
    return f"ملخص حضور الموظفين لشهر {month_label}"

def build_attendance_pdf_styles(font_name: str) -> dict[str, ParagraphStyle]:
    styles = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "AttendanceTitle",
            parent=styles["Title"],
            fontName=font_name,
            fontSize=20,
            leading=24,
            textColor=colors.HexColor("#0f172a"),
            alignment=TA_CENTER,
            spaceAfter=8,
        ),
        "subtitle": ParagraphStyle(
            "AttendanceSubtitle",
            parent=styles["BodyText"],
            fontName=font_name,
            fontSize=10,
            leading=13,
            textColor=colors.HexColor("#475569"),
            alignment=TA_CENTER,
            spaceAfter=12,
        ),
        "section": ParagraphStyle(
            "AttendanceSection",
            parent=styles["Heading3"],
            fontName=font_name,
            fontSize=12,
            leading=14,
            textColor=colors.HexColor("#0f172a"),
            alignment=TA_RIGHT,
            spaceBefore=8,
            spaceAfter=6,
        ),
        "body": ParagraphStyle(
            "AttendanceBody",
            parent=styles["BodyText"],
            fontName=font_name,
            fontSize=9,
            leading=12,
            textColor=colors.HexColor("#1e293b"),
            alignment=TA_RIGHT,
        ),
    }

def build_info_table(items: list[tuple[str, str]], font_name: str) -> Table:
    styles = build_attendance_pdf_styles(font_name)
    rows = []
    for idx in range(0, len(items), 2):
        pair = items[idx:idx + 2]
        row = []
        for label, value in pair:
            row.append(Paragraph(
                f"<b>{escape(pdf_rtl_text(label))}</b><br/>{escape(pdf_rtl_text(value or '—'))}",
                styles["body"],
            ))
        if len(pair) == 1:
            row.append("")
        rows.append(row)

    table = Table(rows, colWidths=[95 * mm, 95 * mm], hAlign="CENTER")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#dbe3ee")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def append_attendance_branding(elements: list, styles: dict[str, ParagraphStyle], branding: dict | None, subtitle: str) -> None:
    append_brand_logo(elements, branding)
    subtitle_parts = build_branding_identity_parts(branding)
    if subtitle_parts:
        elements.append(pdf_paragraph(" • ".join(subtitle_parts), styles["subtitle"]))
    elements.append(pdf_paragraph(subtitle, styles["subtitle"]))

def build_employee_pdf(
    employee: dict,
    status_row: dict | None,
    year: int,
    month: int,
    workday_hours: float,
    branding: dict | None = None,
) -> bytes:
    font_name = _ensure_pdf_font()
    styles = build_attendance_pdf_styles(font_name)
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title=f"Attendance Report {employee['id']} {year}-{month:02d}",
    )

    daily = employee.get("daily", [])
    qualified_days = sum(1 for day in daily if is_qualified_workday(day.get("hours"), workday_hours))
    abnormal_days = sum(1 for day in daily if day.get("is_abnormal"))
    overtime_total = round(sum(overtime_hours_value(day.get("hours"), workday_hours) for day in daily), 2)
    total_periods = sum(int(day.get("sessions_count") or 0) for day in daily)
    workday_label = format_workday_hours_label(workday_hours)

    elements = [
        pdf_paragraph("تقرير حضور الموظف", styles["title"]),
        pdf_paragraph(f"تقرير شهري مبني على مدد الاتصال الفعلية فقط • {year}-{month:02d}", styles["subtitle"]),
        build_info_table([
            ("الموظف", str(employee.get("name") or "—")),
            ("الدور", role_label(employee.get("role"))),
            ("الحالة الحالية", "متصل" if (status_row or {}).get("status") == "online" else "غير متصل"),
            ("آخر ظهور", format_iso_local_time((status_row or {}).get("last_seen"))),
            ("إجمالي ساعات الشهر", format_hours_value(employee.get("total_monthly_hours"))),
            (f"أيام العمل المكتملة ({workday_label})", str(qualified_days)),
            ("الساعات الإضافية", format_hours_value(overtime_total)),
            ("أيام بحاجة مراجعة", str(abnormal_days)),
            ("عدد الفترات", str(total_periods)),
            ("الشهر", f"{year}-{month:02d}"),
        ], font_name),
        Spacer(1, 8),
        pdf_paragraph("الحضور اليومي", styles["section"]),
    ]

    daily_rows = [[
        pdf_paragraph("التاريخ", styles["body"]),
        pdf_paragraph("اليوم", styles["body"]),
        pdf_paragraph("أول اتصال", styles["body"]),
        pdf_paragraph("آخر انقطاع", styles["body"]),
        pdf_paragraph("الفترات", styles["body"]),
        pdf_paragraph("ساعات الاتصال", styles["body"]),
        pdf_paragraph("الإضافي", styles["body"]),
        pdf_paragraph("الحالة", styles["body"]),
    ]]
    for day in daily:
        daily_rows.append([
            pdf_paragraph(day.get("date") or "—", styles["body"]),
            pdf_paragraph(f"{day.get('day', 0):02d}", styles["body"]),
            pdf_paragraph(format_iso_local_time(day.get("first_connected")), styles["body"]),
            pdf_paragraph(format_iso_local_time(day.get("last_disconnected")), styles["body"]),
            pdf_paragraph(str(int(day.get("sessions_count") or 0)), styles["body"]),
            pdf_paragraph(format_hours_value(day.get("hours")), styles["body"]),
            pdf_paragraph(format_hours_value(overtime_hours_value(day.get("hours"), workday_hours)) if overtime_hours_value(day.get("hours"), workday_hours) > 0 else "—", styles["body"]),
            pdf_paragraph(day_status_label(day, workday_hours), styles["body"]),
        ])

    daily_table = Table(
        daily_rows,
        colWidths=[29 * mm, 14 * mm, 29 * mm, 30 * mm, 16 * mm, 23 * mm, 20 * mm, 29 * mm],
        repeatRows=1,
        hAlign="CENTER",
    )
    daily_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    for idx, day in enumerate(daily, start=1):
        if day.get("is_abnormal"):
            daily_table.setStyle(TableStyle([
                ("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#fef2f2")),
            ]))
        elif overtime_hours_value(day.get("hours"), workday_hours) > 0:
            daily_table.setStyle(TableStyle([
                ("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#f0f9ff")),
            ]))
    elements.append(daily_table)

    period_rows = [[pdf_rtl_text("التاريخ"), pdf_rtl_text("تفاصيل الفترات")]]
    for day in daily:
        periods = day.get("periods") or []
        details = "\n".join(
            pdf_rtl_text(f"#{index + 1} {format_period_label(period.get('connected_at'), period.get('disconnected_at'))} ({format_hours_value(period.get('hours'))})")
            for index, period in enumerate(periods)
        ) or pdf_rtl_text("—")
        period_rows.append([pdf_rtl_text(day.get("date") or "—"), details])

    elements.extend([
        Spacer(1, 10),
        pdf_paragraph("تفاصيل فترات الاتصال", styles["section"]),
        Table(period_rows, colWidths=[38 * mm, 220 * mm], repeatRows=1, hAlign="CENTER", style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
            ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("FONTNAME", (0, 0), (-1, -1), font_name),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ])),
    ])

    doc.build(elements)
    return buffer.getvalue()

def build_all_employees_pdf(
    report: list[dict],
    status_rows: list[dict],
    year: int,
    month: int,
    workday_hours: float,
    branding: dict | None = None,
) -> bytes:
    font_name = _ensure_pdf_font()
    styles = build_attendance_pdf_styles(font_name)
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title=f"Attendance Summary {year}-{month:02d}",
    )

    status_map = {row["id"]: row for row in status_rows}
    total_hours = round(sum(float(employee.get("total_monthly_hours") or 0) for employee in report), 2)
    total_overtime = round(
        sum(overtime_hours_value(day.get("hours"), workday_hours) for employee in report for day in employee.get("daily", [])),
        2,
    )
    total_abnormal_days = sum(
        1 for employee in report for day in employee.get("daily", []) if day.get("is_abnormal")
    )

    elements = [
        pdf_paragraph("ملخص حضور الموظفين الشهري", styles["title"]),
        pdf_paragraph(f"الحضور مبني على مدد الاتصال الفعلية فقط • {year}-{month:02d}", styles["subtitle"]),
        build_info_table([
            ("عدد الموظفين", str(len(report))),
            ("الشهر", f"{year}-{month:02d}"),
            ("إجمالي ساعات الاتصال", format_hours_value(total_hours)),
            ("إجمالي الإضافي", format_hours_value(total_overtime)),
            ("أيام بحاجة مراجعة", str(total_abnormal_days)),
            ("وقت التوليد", local_now().strftime("%Y-%m-%d %H:%M")),
        ], font_name),
        Spacer(1, 8),
        pdf_paragraph("ملخص الموظفين", styles["section"]),
    ]

    summary_rows = [[
        pdf_paragraph("الموظف", styles["body"]),
        pdf_paragraph("الدور", styles["body"]),
        pdf_paragraph("الحالة", styles["body"]),
        pdf_paragraph("إجمالي الساعات", styles["body"]),
        pdf_paragraph("الأيام المكتملة", styles["body"]),
        pdf_paragraph("الإضافي", styles["body"]),
        pdf_paragraph("أيام المراجعة", styles["body"]),
    ]]

    for employee in report:
        worked_days = sum(1 for day in employee.get("daily", []) if is_qualified_workday(day.get("hours"), workday_hours))
        abnormal_days = sum(1 for day in employee.get("daily", []) if day.get("is_abnormal"))
        overtime_total = round(sum(overtime_hours_value(day.get("hours"), workday_hours) for day in employee.get("daily", [])), 2)
        status_text = "متصل" if status_map.get(employee["id"], {}).get("status") == "online" else "غير متصل"
        summary_rows.append([
            pdf_paragraph(employee.get("name") or "—", styles["body"]),
            pdf_paragraph(role_label(employee.get("role")), styles["body"]),
            pdf_paragraph(status_text, styles["body"]),
            pdf_paragraph(format_hours_value(employee.get("total_monthly_hours")), styles["body"]),
            pdf_paragraph(str(worked_days), styles["body"]),
            pdf_paragraph(format_hours_value(overtime_total), styles["body"]),
            pdf_paragraph(str(abnormal_days), styles["body"]),
        ])

    summary_table = Table(
        summary_rows,
        colWidths=[55 * mm, 27 * mm, 28 * mm, 28 * mm, 24 * mm, 26 * mm, 24 * mm],
        repeatRows=1,
        hAlign="CENTER",
    )
    summary_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    elements.append(summary_table)

    doc.build(elements)
    return buffer.getvalue()


def build_employee_pdf_branded(
    employee: dict,
    status_row: dict | None,
    year: int,
    month: int,
    workday_hours: float,
    branding: dict | None = None,
) -> bytes:
    font_name = _ensure_pdf_font()
    styles = build_attendance_pdf_styles(font_name)
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title=f"Attendance Report {employee['id']} {year}-{month:02d}",
    )

    daily = employee.get("daily", [])
    qualified_days = sum(1 for day in daily if is_qualified_workday(day.get("hours"), workday_hours))
    abnormal_days = sum(1 for day in daily if day.get("is_abnormal"))
    overtime_total = round(sum(overtime_hours_value(day.get("hours"), workday_hours) for day in daily), 2)
    total_periods = sum(int(day.get("sessions_count") or 0) for day in daily)
    workday_label = format_workday_hours_label(workday_hours)

    elements = [pdf_paragraph("تقرير حضور الموظف", styles["title"])]
    append_attendance_branding(elements, styles, branding, f"تقرير شهري مبني على مدد الاتصال الفعلية فقط • {year}-{month:02d}")
    elements.extend([
        build_info_table([
            ("الموظف", str(employee.get("name") or "—")),
            ("الدور", role_label(employee.get("role"))),
            ("الحالة الحالية", "متصل" if (status_row or {}).get("status") == "online" else "غير متصل"),
            ("آخر ظهور", format_iso_local_time((status_row or {}).get("last_seen"))),
            ("إجمالي ساعات الشهر", format_hours_value(employee.get("total_monthly_hours"))),
            (f"أيام العمل المكتملة ({workday_label})", str(qualified_days)),
            ("الساعات الإضافية", format_hours_value(overtime_total)),
            ("أيام بحاجة مراجعة", str(abnormal_days)),
            ("عدد الفترات", str(total_periods)),
            ("الشهر", f"{year}-{month:02d}"),
        ], font_name),
        Spacer(1, 8),
        pdf_paragraph("الحضور اليومي", styles["section"]),
    ])

    daily_rows = [[
        pdf_paragraph("التاريخ", styles["body"]),
        pdf_paragraph("اليوم", styles["body"]),
        pdf_paragraph("أول اتصال", styles["body"]),
        pdf_paragraph("آخر انقطاع", styles["body"]),
        pdf_paragraph("الفترات", styles["body"]),
        pdf_paragraph("ساعات الاتصال", styles["body"]),
        pdf_paragraph("الإضافي", styles["body"]),
        pdf_paragraph("الحالة", styles["body"]),
    ]]
    for day in daily:
        extra_hours = overtime_hours_value(day.get("hours"), workday_hours)
        daily_rows.append([
            pdf_paragraph(day.get("date") or "—", styles["body"]),
            pdf_paragraph(f"{day.get('day', 0):02d}", styles["body"]),
            pdf_paragraph(format_iso_local_time(day.get("first_connected")), styles["body"]),
            pdf_paragraph(format_iso_local_time(day.get("last_disconnected")), styles["body"]),
            pdf_paragraph(str(int(day.get("sessions_count") or 0)), styles["body"]),
            pdf_paragraph(format_hours_value(day.get("hours")), styles["body"]),
            pdf_paragraph(format_hours_value(extra_hours) if extra_hours > 0 else "—", styles["body"]),
            pdf_paragraph(day_status_label(day, workday_hours), styles["body"]),
        ])

    daily_table = Table(
        daily_rows,
        colWidths=[29 * mm, 14 * mm, 29 * mm, 30 * mm, 16 * mm, 23 * mm, 20 * mm, 29 * mm],
        repeatRows=1,
        hAlign="CENTER",
    )
    daily_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    for idx, day in enumerate(daily, start=1):
        if day.get("is_abnormal"):
            daily_table.setStyle(TableStyle([("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#fef2f2"))]))
        elif overtime_hours_value(day.get("hours"), workday_hours) > 0:
            daily_table.setStyle(TableStyle([("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#f0f9ff"))]))
    elements.append(daily_table)

    period_rows = [[pdf_rtl_text("التاريخ"), pdf_rtl_text("تفاصيل الفترات")]]
    for day in daily:
        periods = day.get("periods") or []
        details = "\n".join(
            pdf_rtl_text(
                f"#{index + 1} {format_period_label(period.get('connected_at'), period.get('disconnected_at'))} ({format_hours_value(period.get('hours'))})"
            )
            for index, period in enumerate(periods)
        ) or pdf_rtl_text("—")
        period_rows.append([pdf_rtl_text(day.get("date") or "—"), details])

    elements.extend([
        Spacer(1, 10),
        pdf_paragraph("تفاصيل فترات الاتصال", styles["section"]),
        Table(period_rows, colWidths=[38 * mm, 220 * mm], repeatRows=1, hAlign="CENTER", style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
            ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("FONTNAME", (0, 0), (-1, -1), font_name),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ])),
    ])

    doc.build(elements)
    return buffer.getvalue()


def build_all_employees_pdf_branded(
    report: list[dict],
    status_rows: list[dict],
    year: int,
    month: int,
    workday_hours: float,
    branding: dict | None = None,
) -> bytes:
    font_name = _ensure_pdf_font()
    styles = build_attendance_pdf_styles(font_name)
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title=f"Attendance Summary {year}-{month:02d}",
    )

    status_map = {row["id"]: row for row in status_rows}
    total_hours = round(sum(float(employee.get("total_monthly_hours") or 0) for employee in report), 2)
    total_overtime = round(
        sum(overtime_hours_value(day.get("hours"), workday_hours) for employee in report for day in employee.get("daily", [])),
        2,
    )
    total_abnormal_days = sum(1 for employee in report for day in employee.get("daily", []) if day.get("is_abnormal"))

    elements = [pdf_paragraph("ملخص حضور الموظفين الشهري", styles["title"])]
    append_attendance_branding(elements, styles, branding, f"الحضور مبني على مدد الاتصال الفعلية فقط • {year}-{month:02d}")
    elements.extend([
        build_info_table([
            ("عدد الموظفين", str(len(report))),
            ("الشهر", f"{year}-{month:02d}"),
            ("إجمالي ساعات الاتصال", format_hours_value(total_hours)),
            ("إجمالي الإضافي", format_hours_value(total_overtime)),
            ("أيام بحاجة مراجعة", str(total_abnormal_days)),
            ("وقت التوليد", local_now().strftime("%Y-%m-%d %H:%M")),
        ], font_name),
        Spacer(1, 8),
        pdf_paragraph("ملخص الموظفين", styles["section"]),
    ])

    summary_rows = [[
        pdf_paragraph("الموظف", styles["body"]),
        pdf_paragraph("الدور", styles["body"]),
        pdf_paragraph("الحالة", styles["body"]),
        pdf_paragraph("إجمالي الساعات", styles["body"]),
        pdf_paragraph("الأيام المكتملة", styles["body"]),
        pdf_paragraph("الإضافي", styles["body"]),
        pdf_paragraph("أيام المراجعة", styles["body"]),
    ]]

    for employee in report:
        worked_days = sum(1 for day in employee.get("daily", []) if is_qualified_workday(day.get("hours"), workday_hours))
        abnormal_days = sum(1 for day in employee.get("daily", []) if day.get("is_abnormal"))
        overtime_total = round(sum(overtime_hours_value(day.get("hours"), workday_hours) for day in employee.get("daily", [])), 2)
        status_text = "متصل" if status_map.get(employee["id"], {}).get("status") == "online" else "غير متصل"
        summary_rows.append([
            pdf_paragraph(employee.get("name") or "—", styles["body"]),
            pdf_paragraph(role_label(employee.get("role")), styles["body"]),
            pdf_paragraph(status_text, styles["body"]),
            pdf_paragraph(format_hours_value(employee.get("total_monthly_hours")), styles["body"]),
            pdf_paragraph(str(worked_days), styles["body"]),
            pdf_paragraph(format_hours_value(overtime_total), styles["body"]),
            pdf_paragraph(str(abnormal_days), styles["body"]),
        ])

    summary_table = Table(
        summary_rows,
        colWidths=[55 * mm, 27 * mm, 28 * mm, 28 * mm, 24 * mm, 26 * mm, 24 * mm],
        repeatRows=1,
        hAlign="CENTER",
    )
    summary_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    elements.append(summary_table)

    doc.build(elements)
    return buffer.getvalue()

@router.get("/status")
async def current_status(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    """جلب حالة الاتصال الحالية لكل الموظفين (للمدير)"""
    users = (await db.execute(select(User).where(User.is_active == True))).scalars().all()
    result = []
    
    for u in users:
        # Get the latest session
        session_res = await db.execute(
            select(CashierSession)
            .where(CashierSession.user_id == u.id)
            .order_by(CashierSession.opened_at.desc())
            .limit(1)
        )
        s = session_res.scalar_one_or_none()
        
        status = "offline"
        last_seen = None
        
        if s:
            last_seen = session_last_seen(s)
            if s.is_active:
                if last_seen and not session_is_stale(s):
                    status = "online"
                else:
                    status = "offline"  # Idle/Dead session
                
        result.append({
            "id": u.id,
            "name": u.name,
            "username": u.username,
            "role": u.role,
            "status": status,
            "last_seen": local_iso(last_seen),
        })
        
    return result

@router.get("/monthly")
async def monthly_attendance(
    year: int,
    month: int,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    """
    تقرير الحضور والانصراف الشهري مفصل بالأيام
    يتم جمع مدة الجلسات لكل يوم لكل موظف.
    """
    year, month = validate_year_month(year, month)
    workday_hours = await get_workday_hours_setting(db)
    utc_start, utc_end = get_month_boundaries(year, month)
    
    # Get all sessions overlapping this month
    stmt = select(CashierSession).join(User).where(
        and_(
            CashierSession.opened_at < utc_end,
            or_(
                CashierSession.closed_at >= utc_start,
                CashierSession.is_active == True
            )
        )
    )
    
    sessions = (await db.execute(stmt)).scalars().all()
    users = (await db.execute(select(User).where(User.is_active == True))).scalars().all()
    
    # Initialize report map
    # user_id -> { "user": dict, "days": dict[int, dict] }
    report = {
        u.id: {
            "id": u.id,
            "name": u.name,
            "username": u.username,
            "role": u.role,
            "days": {day: {
                "total_seconds": 0, 
                "sessions_count": 0, 
                "abnormal": False,
                "first_connected": None,
                "last_disconnected": None,
                "periods": [],
            } for day in range(1, 32)},
            "total_monthly_seconds": 0
        } for u in users
    }
    
    now = utc_now()
    for s in sessions:
        if s.user_id not in report:
            continue

        last_seen = session_last_seen(s)
        real_closed_at = s.closed_at or last_seen or now
        if real_closed_at < s.opened_at:
            real_closed_at = s.opened_at

        local_opened_at = to_local(s.opened_at)
        if not local_opened_at:
            continue
        if local_opened_at.year != year or local_opened_at.month != month:
            continue

        day_num = local_opened_at.day
        stats = report[s.user_id]["days"][day_num]

        utc_day_start, utc_next_day_start = local_day_range(f"{year:04d}-{month:02d}-{day_num:02d}")

        overlap_start = max(s.opened_at, utc_day_start)
        overlap_end = min(real_closed_at, utc_next_day_start)
        delta_seconds = max(0, (overlap_end - overlap_start).total_seconds())

        if delta_seconds <= 0:
            continue

        stats["total_seconds"] += delta_seconds
        stats["sessions_count"] += 1
        stats["periods"].append({
            "connected_at": local_iso(overlap_start),
            "disconnected_at": local_iso(overlap_end),
            "hours": round(delta_seconds / 3600, 2),
        })

        if s.is_abnormal or session_is_stale(s, now):
            stats["abnormal"] = True

        if not stats["first_connected"] or s.opened_at < stats["first_connected"]:
            stats["first_connected"] = s.opened_at
        if not stats["last_disconnected"] or overlap_end > stats["last_disconnected"]:
            stats["last_disconnected"] = overlap_end
            
    # Format output
    result = []
    for u_id, data in report.items():
        daily_list = []
        monthly_total = 0
        
        _, max_days = calendar.monthrange(year, month)
        
        for day in range(1, max_days + 1):
            day_data = data["days"][day]
            monthly_total += day_data["total_seconds"]
            day_periods = sorted(day_data["periods"], key=lambda period: period.get("connected_at") or "")
            
            first_conn = local_iso(day_data["first_connected"])
            last_conn = local_iso(day_data["last_disconnected"])
            
            daily_list.append({
                "day": day,
                "date": f"{year}-{month:02d}-{day:02d}",
                "hours": round(day_data["total_seconds"] / 3600, 2),
                "sessions_count": day_data["sessions_count"],
                "is_abnormal": day_data["abnormal"],
                "first_connected": first_conn,
                "last_disconnected": last_conn,
                "periods": day_periods,
            })
            
        data["daily"] = daily_list
        data["total_monthly_hours"] = round(monthly_total / 3600, 2)
        data["workday_hours_target"] = workday_hours
        del data["days"] # cleanup mapping
        del data["total_monthly_seconds"]
        result.append(data)
        
    # Sort by name
    result.sort(key=lambda x: x["name"])
    return result

@router.post("/send-telegram")
async def send_attendance_telegram(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    year = int(payload.get("year") or local_now().year)
    month = int(payload.get("month") or local_now().month)
    scope = (payload.get("scope") or "employee").strip().lower()
    employee_id = payload.get("employee_id")

    year, month = validate_year_month(year, month)
    if scope not in {"employee", "all"}:
        raise HTTPException(400, "نوع الإرسال غير صالح")

    from telegram_alerts import send_document

    report = await monthly_attendance(year=year, month=month, db=db, _=None)
    if not report:
        raise HTTPException(404, "لا توجد بيانات حضور لهذا الشهر")
    workday_hours = await get_workday_hours_setting(db)
    status_rows = await current_status(db=db, _=None)
    status_map = {row["id"]: row for row in status_rows}
    branding = await get_store_branding(db)

    if scope == "employee":
        if not employee_id:
            raise HTTPException(400, "يجب تحديد الموظف")
        try:
            employee_id = int(employee_id)
        except (TypeError, ValueError):
            raise HTTPException(400, "معرّف الموظف غير صالح")
        employee = next((item for item in report if item["id"] == employee_id), None)
        if not employee:
            raise HTTPException(404, "الموظف غير موجود في تقرير هذا الشهر")
        pdf_bytes = build_employee_pdf_branded(employee, status_map.get(employee_id), year, month, workday_hours, branding)
        ok = await send_document(
            filename=f"attendance-{year}-{month:02d}-employee-{employee_id}.pdf",
            data=pdf_bytes,
            caption=build_pdf_caption("employee", year, month, employee["name"]),
        )
        if not ok:
            raise HTTPException(503, "تعذر الإرسال إلى تيليغرام")
        return {
            "ok": True,
            "scope": "employee",
            "document_sent": True,
            "messages_sent": 1,
            "employee_name": employee["name"],
        }

    pdf_bytes = build_all_employees_pdf_branded(report, status_rows, year, month, workday_hours, branding)
    ok = await send_document(
        filename=f"attendance-summary-{year}-{month:02d}.pdf",
        data=pdf_bytes,
        caption=build_pdf_caption("all", year, month),
    )
    if not ok:
        raise HTTPException(503, "تعذر الإرسال إلى تيليغرام")
    return {
        "ok": True,
        "scope": "all",
        "document_sent": True,
        "messages_sent": 1,
        "employees_count": len(report),
    }
