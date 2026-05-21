from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import Category, Invoice, InvoiceItem, InvoiceReturn, InvoiceReturnItem, Product
from services.timezone_service import LOCAL_TIMEZONE, local_day_range, local_month_range, local_now, to_local


PAYMENT_METHOD_LABELS = {
    "cash": "نقدًا",
    "card": "بطاقة",
    "digital": "تحويل / رقمي",
}


@dataclass(frozen=True)
class DashboardPeriod:
    preset: str
    start: datetime
    end: datetime
    date_from: str
    date_to: str
    label: str
    day_count: int


def _as_float(value: Any) -> float:
    if value is None:
        return 0.0
    return round(float(value), 2)


def _as_qty(value: Any) -> float:
    if value is None:
        return 0.0
    return round(float(value), 3)


def _normalize_preset(value: str | None) -> str:
    normalized = str(value or "month").strip().lower()
    if normalized not in {"today", "week", "month", "custom"}:
        return "month"
    return normalized


def _localize_date(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed.astimezone(LOCAL_TIMEZONE) if parsed.tzinfo else parsed.replace(tzinfo=LOCAL_TIMEZONE)


def resolve_dashboard_period(
    *,
    preset: str | None,
    date_from: str | None,
    date_to: str | None,
) -> DashboardPeriod:
    normalized = _normalize_preset(preset)
    if normalized == "today":
        start, end = local_day_range(date_from)
        label = "اليوم"
    elif normalized == "month":
        month_value = (date_from or "").strip() or None
        if month_value and len(month_value) > 7:
            month_value = month_value[:7]
        start, end = local_month_range(month_value)
        start_local = to_local(start)
        label = f"شهر {start_local.strftime('%m/%Y')}" if start_local else "هذا الشهر"
    elif normalized == "week":
        anchor = _localize_date(date_from) if date_from else local_now()
        local_start = (anchor - timedelta(days=anchor.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        local_end = local_start + timedelta(days=7)
        start = local_start.astimezone(timezone.utc).replace(tzinfo=None)
        end = local_end.astimezone(timezone.utc).replace(tzinfo=None)
        label = "هذا الأسبوع"
    else:
        if not date_from or not date_to:
            raise ValueError("يجب تحديد تاريخ البداية والنهاية للفترة المخصصة.")
        start_local = _localize_date(date_from).replace(hour=0, minute=0, second=0, microsecond=0)
        end_local = _localize_date(date_to).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        if end_local <= start_local:
            raise ValueError("تاريخ النهاية يجب أن يكون بعد تاريخ البداية.")
        start = start_local.astimezone(timezone.utc).replace(tzinfo=None)
        end = end_local.astimezone(timezone.utc).replace(tzinfo=None)
        label = "فترة مخصصة"

    local_start = to_local(start)
    local_end = to_local(end - timedelta(seconds=1))
    if not local_start or not local_end:
        raise ValueError("تعذر تحديد الفترة الزمنية المطلوبة.")
    day_count = max(1, (local_end.date() - local_start.date()).days + 1)
    return DashboardPeriod(
        preset=normalized,
        start=start,
        end=end,
        date_from=local_start.date().isoformat(),
        date_to=local_end.date().isoformat(),
        label=label,
        day_count=day_count,
    )


def _local_date_key(value: datetime | None) -> str:
    localized = to_local(value)
    return localized.date().isoformat() if localized else ""


def _local_day_label(value: str) -> str:
    day = datetime.fromisoformat(value)
    return day.strftime("%d/%m")


def _local_hour(value: datetime | None) -> int:
    localized = to_local(value)
    return localized.hour if localized else 0


def _payment_label(value: str | None) -> str:
    key = str(value or "").strip().lower()
    return PAYMENT_METHOD_LABELS.get(key, key or "غير محدد")


async def build_reports_dashboard(
    db: AsyncSession,
    *,
    preset: str | None,
    date_from: str | None,
    date_to: str | None,
    cashier_id: int | None = None,
    category_id: int | None = None,
    payment_method: str | None = None,
) -> dict[str, Any]:
    period = resolve_dashboard_period(preset=preset, date_from=date_from, date_to=date_to)
    payment_filter = str(payment_method or "").strip().lower() or None

    invoice_stmt = select(Invoice).where(
        Invoice.is_cancelled == False,
        Invoice.created_at >= period.start,
        Invoice.created_at < period.end,
    )
    if cashier_id is not None:
        invoice_stmt = invoice_stmt.where(Invoice.cashier_id == cashier_id)
    if payment_filter:
        invoice_stmt = invoice_stmt.where(Invoice.payment_method == payment_filter)
    invoices = (await db.execute(invoice_stmt)).scalars().all()

    sale_item_stmt = (
        select(InvoiceItem, Invoice, Product, Category)
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .join(Product, Product.id == InvoiceItem.product_id)
        .outerjoin(Category, Category.id == Product.category_id)
        .where(
            Invoice.is_cancelled == False,
            Invoice.created_at >= period.start,
            Invoice.created_at < period.end,
        )
    )
    if cashier_id is not None:
        sale_item_stmt = sale_item_stmt.where(Invoice.cashier_id == cashier_id)
    if payment_filter:
        sale_item_stmt = sale_item_stmt.where(Invoice.payment_method == payment_filter)
    if category_id is not None:
        sale_item_stmt = sale_item_stmt.where(Product.category_id == category_id)
    sale_item_rows = (await db.execute(sale_item_stmt)).all()

    returns_stmt = (
        select(InvoiceReturn, Invoice)
        .join(Invoice, Invoice.id == InvoiceReturn.original_invoice_id)
        .where(
            Invoice.is_cancelled == False,
            InvoiceReturn.created_at >= period.start,
            InvoiceReturn.created_at < period.end,
        )
    )
    if cashier_id is not None:
        returns_stmt = returns_stmt.where(Invoice.cashier_id == cashier_id)
    if payment_filter:
        returns_stmt = returns_stmt.where(Invoice.payment_method == payment_filter)
    returns_rows = (await db.execute(returns_stmt)).all()

    return_item_stmt = (
        select(InvoiceReturnItem, InvoiceReturn, Invoice, Product, Category)
        .join(InvoiceReturn, InvoiceReturn.id == InvoiceReturnItem.return_id)
        .join(Invoice, Invoice.id == InvoiceReturn.original_invoice_id)
        .join(Product, Product.id == InvoiceReturnItem.product_id)
        .outerjoin(Category, Category.id == Product.category_id)
        .where(
            Invoice.is_cancelled == False,
            InvoiceReturn.created_at >= period.start,
            InvoiceReturn.created_at < period.end,
        )
    )
    if cashier_id is not None:
        return_item_stmt = return_item_stmt.where(Invoice.cashier_id == cashier_id)
    if payment_filter:
        return_item_stmt = return_item_stmt.where(Invoice.payment_method == payment_filter)
    if category_id is not None:
        return_item_stmt = return_item_stmt.where(Product.category_id == category_id)
    return_item_rows = (await db.execute(return_item_stmt)).all()

    product_stmt = select(Product).where(Product.is_active == True)
    if category_id is not None:
        product_stmt = product_stmt.where(Product.category_id == category_id)
    inventory_products = (await db.execute(product_stmt)).scalars().all()

    gross_sales = round(
        sum(_as_float(item.subtotal) for item, _, _, _ in sale_item_rows)
        if category_id is not None
        else sum(_as_float(invoice.final_total) for invoice in invoices),
        2,
    )
    total_returns = round(
        sum(_as_float(item.subtotal) for item, _, _, _, _ in return_item_rows)
        if category_id is not None
        else sum(_as_float(return_row.total_refunded) for return_row, _ in returns_rows),
        2,
    )
    invoice_count = (
        len({invoice.id for _, invoice, _, _ in sale_item_rows}) if category_id is not None else len(invoices)
    )
    return_count = (
        len({return_row.id for _, return_row, _, _, _ in return_item_rows})
        if category_id is not None
        else len(returns_rows)
    )
    net_sales = round(gross_sales - total_returns, 2)
    average_invoice_value = round(net_sales / invoice_count, 2) if invoice_count else 0.0

    day_series: dict[str, dict[str, float | str]] = {}
    for offset in range(period.day_count):
        day = datetime.fromisoformat(period.date_from) + timedelta(days=offset)
        key = day.date().isoformat()
        day_series[key] = {
            "key": key,
            "label": _local_day_label(key),
            "gross_sales": 0.0,
            "returns": 0.0,
            "net_sales": 0.0,
        }

    hourly_sales: dict[int, dict[str, float | int | str]] = {
        hour: {"hour": hour, "label": f"{hour:02d}:00", "invoices": 0, "gross_sales": 0.0}
        for hour in range(24)
    }
    payment_methods: dict[str, dict[str, Any]] = {}
    product_metrics: dict[int, dict[str, Any]] = {}
    category_metrics: dict[str, dict[str, Any]] = {}

    if category_id is None:
        for invoice in invoices:
            day_key = _local_date_key(invoice.created_at)
            gross_value = _as_float(invoice.final_total)
            if day_key in day_series:
                day_series[day_key]["gross_sales"] = round(float(day_series[day_key]["gross_sales"]) + gross_value, 2)
            hour_bucket = hourly_sales[_local_hour(invoice.created_at)]
            hour_bucket["gross_sales"] = round(float(hour_bucket["gross_sales"]) + gross_value, 2)
            hour_bucket["invoices"] = int(hour_bucket["invoices"]) + 1
            method_key = str(invoice.payment_method or "unknown").lower()
            entry = payment_methods.setdefault(
                method_key,
                {"payment_method": method_key, "label": _payment_label(method_key), "count": 0, "amount": 0.0},
            )
            entry["count"] += 1
            entry["amount"] = round(float(entry["amount"]) + gross_value, 2)
    else:
        payment_invoice_sets: dict[str, set[int]] = defaultdict(set)
        for invoice_item, invoice, _, _ in sale_item_rows:
            gross_value = _as_float(invoice_item.subtotal)
            day_key = _local_date_key(invoice.created_at)
            if day_key in day_series:
                day_series[day_key]["gross_sales"] = round(float(day_series[day_key]["gross_sales"]) + gross_value, 2)
            hour_bucket = hourly_sales[_local_hour(invoice.created_at)]
            hour_bucket["gross_sales"] = round(float(hour_bucket["gross_sales"]) + gross_value, 2)
            hour_bucket["invoices"] = int(hour_bucket["invoices"]) + 1
            method_key = str(invoice.payment_method or "unknown").lower()
            entry = payment_methods.setdefault(
                method_key,
                {"payment_method": method_key, "label": _payment_label(method_key), "count": 0, "amount": 0.0},
            )
            payment_invoice_sets[method_key].add(invoice.id)
            entry["amount"] = round(float(entry["amount"]) + gross_value, 2)
        for method_key, invoice_ids in payment_invoice_sets.items():
            payment_methods[method_key]["count"] = len(invoice_ids)

    for invoice_item, invoice, product, category in sale_item_rows:
        product_entry = product_metrics.setdefault(
            product.id,
            {
                "product_id": product.id,
                "name": product.name,
                "barcode": product.barcode,
                "category_name": getattr(category, "name", None),
                "sold_qty": 0.0,
                "returned_qty": 0.0,
                "gross_revenue": 0.0,
                "returned_revenue": 0.0,
                "stock": _as_qty(product.stock),
                "min_stock": _as_qty(product.min_stock),
            },
        )
        category_key = str(category.id) if category else "uncategorized"
        category_entry = category_metrics.setdefault(
            category_key,
            {
                "category_id": getattr(category, "id", None),
                "category_name": getattr(category, "name", None) or "غير مصنف",
                "sold_qty": 0.0,
                "returned_qty": 0.0,
                "gross_revenue": 0.0,
                "returned_revenue": 0.0,
            },
        )
        sold_qty = _as_qty(invoice_item.quantity)
        sold_revenue = _as_float(invoice_item.subtotal)
        product_entry["sold_qty"] = round(float(product_entry["sold_qty"]) + sold_qty, 3)
        product_entry["gross_revenue"] = round(float(product_entry["gross_revenue"]) + sold_revenue, 2)
        category_entry["sold_qty"] = round(float(category_entry["sold_qty"]) + sold_qty, 3)
        category_entry["gross_revenue"] = round(float(category_entry["gross_revenue"]) + sold_revenue, 2)

    for return_item, return_row, _, product, category in return_item_rows:
        returned_value = _as_float(return_item.subtotal)
        day_key = _local_date_key(return_row.created_at)
        if day_key in day_series:
            day_series[day_key]["returns"] = round(float(day_series[day_key]["returns"]) + returned_value, 2)
        product_entry = product_metrics.setdefault(
            product.id,
            {
                "product_id": product.id,
                "name": product.name,
                "barcode": product.barcode,
                "category_name": getattr(category, "name", None),
                "sold_qty": 0.0,
                "returned_qty": 0.0,
                "gross_revenue": 0.0,
                "returned_revenue": 0.0,
                "stock": _as_qty(product.stock),
                "min_stock": _as_qty(product.min_stock),
            },
        )
        category_key = str(category.id) if category else "uncategorized"
        category_entry = category_metrics.setdefault(
            category_key,
            {
                "category_id": getattr(category, "id", None),
                "category_name": getattr(category, "name", None) or "غير مصنف",
                "sold_qty": 0.0,
                "returned_qty": 0.0,
                "gross_revenue": 0.0,
                "returned_revenue": 0.0,
            },
        )
        returned_qty = _as_qty(return_item.quantity)
        product_entry["returned_qty"] = round(float(product_entry["returned_qty"]) + returned_qty, 3)
        product_entry["returned_revenue"] = round(float(product_entry["returned_revenue"]) + returned_value, 2)
        category_entry["returned_qty"] = round(float(category_entry["returned_qty"]) + returned_qty, 3)
        category_entry["returned_revenue"] = round(float(category_entry["returned_revenue"]) + returned_value, 2)

    for series_point in day_series.values():
        series_point["net_sales"] = round(float(series_point["gross_sales"]) - float(series_point["returns"]), 2)

    top_products: list[dict[str, Any]] = []
    for entry in product_metrics.values():
        entry["net_qty"] = round(float(entry["sold_qty"]) - float(entry["returned_qty"]), 3)
        entry["net_revenue"] = round(float(entry["gross_revenue"]) - float(entry["returned_revenue"]), 2)
        top_products.append(entry)
    top_products.sort(key=lambda item: (item["net_qty"], item["net_revenue"]), reverse=True)

    category_performance: list[dict[str, Any]] = []
    for entry in category_metrics.values():
        entry["net_qty"] = round(float(entry["sold_qty"]) - float(entry["returned_qty"]), 3)
        entry["net_revenue"] = round(float(entry["gross_revenue"]) - float(entry["returned_revenue"]), 2)
        category_performance.append(entry)
    category_performance.sort(key=lambda item: item["net_revenue"], reverse=True)

    today_local = local_now()
    expiry_threshold = today_local + timedelta(days=30)
    low_stock: list[dict[str, Any]] = []
    near_expiry: list[dict[str, Any]] = []
    out_of_stock_count = 0
    low_stock_count = 0
    near_expiry_count = 0
    estimated_inventory_margin = 0.0

    for product in inventory_products:
        stock = _as_qty(product.stock)
        min_stock = _as_qty(product.min_stock)
        estimated_inventory_margin += _as_float(product.price) * stock - _as_float(product.buy_price) * stock
        if stock <= 0:
            out_of_stock_count += 1
            low_stock.append(
                {
                    "id": product.id,
                    "name": product.name,
                    "barcode": product.barcode,
                    "stock": stock,
                    "min_stock": min_stock,
                    "status": "out",
                }
            )
        elif stock <= min_stock:
            low_stock_count += 1
            low_stock.append(
                {
                    "id": product.id,
                    "name": product.name,
                    "barcode": product.barcode,
                    "stock": stock,
                    "min_stock": min_stock,
                    "status": "low",
                }
            )

        if product.expiry_date:
            expiry_local = to_local(product.expiry_date)
            if expiry_local:
                days_left = (expiry_local.date() - today_local.date()).days
                if expiry_local <= expiry_threshold:
                    near_expiry_count += 1
                    near_expiry.append(
                        {
                            "id": product.id,
                            "name": product.name,
                            "barcode": product.barcode,
                            "stock": stock,
                            "expiry_date": expiry_local.isoformat(),
                            "days_left": days_left,
                            "status": "expired" if days_left < 0 else "warning",
                        }
                    )

    top_product = next((item for item in top_products if item["net_qty"] > 0), None)
    leading_category = next((item for item in category_performance if item["net_revenue"] > 0), None)

    insights: list[dict[str, str]] = []
    if top_product:
        insights.append(
            {
                "id": "top_product",
                "type": "top_product",
                "tone": "positive",
                "title": "المنتج الأعلى مبيعًا",
                "body": f"أكثر منتج مبيعًا خلال هذه الفترة هو {top_product['name']} بصافي كمية {top_product['net_qty']:.0f}.",
                "basis": "مبني على صافي الكمية المباعة بعد خصم المرتجعات خلال الفترة المحددة.",
            }
        )

    if gross_sales > 0 and return_count >= 3 and (total_returns / gross_sales) >= 0.08:
        insights.append(
            {
                "id": "high_returns",
                "type": "high_returns",
                "tone": "warning",
                "title": "المرتجعات مرتفعة",
                "body": f"قيمة المرتجعات تمثل {round((total_returns / gross_sales) * 100, 1)}% من إجمالي المبيعات في هذه الفترة.",
                "basis": "تمت المقارنة بين إجمالي المبيعات في الفترة والمرتجعات المسجلة فعليًا خلال نفس الفترة.",
            }
        )

    if low_stock_count > 0 or out_of_stock_count > 0:
        insights.append(
            {
                "id": "low_stock_attention",
                "type": "inventory",
                "tone": "warning",
                "title": "تنبيه مخزون",
                "body": f"هناك {low_stock_count + out_of_stock_count} منتجًا يحتاج متابعة مخزنية، منها {out_of_stock_count} نافد تمامًا.",
                "basis": "التحليل مبني على المخزون الحالي مقارنةً بالحد الأدنى والتنبيهات النشطة.",
            }
        )

    total_hourly_invoices = sum(int(point["invoices"]) for point in hourly_sales.values())
    if total_hourly_invoices >= 10:
        peak_hour = max(hourly_sales.values(), key=lambda point: (int(point["invoices"]), float(point["gross_sales"])))
        insights.append(
            {
                "id": "peak_hour",
                "type": "traffic",
                "tone": "info",
                "title": "ذروة النشاط البيعي",
                "body": f"أعلى نشاط بيع خلال الفترة كان حول الساعة {peak_hour['label']} بعدد {peak_hour['invoices']} فاتورة.",
                "basis": "الاستنتاج مبني على توزيع الفواتير حسب ساعة إنشاء الفاتورة.",
            }
        )

    if leading_category:
        insights.append(
            {
                "id": "leading_category",
                "type": "category",
                "tone": "positive",
                "title": "الفئة الأفضل أداءً",
                "body": f"الفئة الأعلى أداءً هي {leading_category['category_name']} بصافي مبيعات {leading_category['net_revenue']:.2f}.",
                "basis": "صافي الأداء محسوب من مبيعات الفئة مطروحًا منها مرتجعاتها ضمن الفترة.",
            }
        )

    if period.day_count >= 14:
        slow_candidate = next(
            (
                item
                for item in top_products
                if float(item["stock"] or 0) > max(float(item["min_stock"] or 0) * 1.5, 5)
                and item["net_qty"] <= 1
            ),
            None,
        )
        if slow_candidate:
            insights.append(
                {
                    "id": "slow_moving_product",
                    "type": "slow_moving",
                    "tone": "info",
                    "title": "منتج بطيء الحركة",
                    "body": f"{slow_candidate['name']} يملك مخزونًا أعلى من الحد الأدنى لكن مبيعاته ضعيفة خلال الفترة الحالية.",
                    "basis": "يظهر هذا التنبيه فقط عند وجود فترة كافية وفرق واضح بين المخزون والمبيعات.",
                }
            )

    return {
        "period": {
            "preset": period.preset,
            "date_from": period.date_from,
            "date_to": period.date_to,
            "label": period.label,
            "day_count": period.day_count,
        },
        "kpis": {
            "gross_sales": gross_sales,
            "net_sales": net_sales,
            "total_returns": total_returns,
            "return_count": return_count,
            "invoice_count": invoice_count,
            "average_invoice_value": average_invoice_value,
            "low_stock_products_count": low_stock_count + out_of_stock_count,
            "near_expiry_products_count": near_expiry_count,
            "estimated_inventory_margin": round(estimated_inventory_margin, 2),
            "top_selling_product_name": top_product["name"] if top_product else None,
            "top_selling_product_qty": top_product["net_qty"] if top_product else None,
        },
        "series": {
            "sales_over_time": list(day_series.values()),
            "returns_vs_sales": list(day_series.values()),
            "top_products": top_products[:10],
            "category_performance": category_performance[:8],
            "hourly_sales": list(hourly_sales.values()),
            "payment_methods": sorted(payment_methods.values(), key=lambda item: item["amount"], reverse=True),
        },
        "insights": insights,
        "alerts": {
            "low_stock_count": low_stock_count,
            "out_of_stock_count": out_of_stock_count,
            "near_expiry_count": near_expiry_count,
            "low_stock": low_stock[:8],
            "near_expiry": near_expiry[:8],
        },
        "tables": {
            "top_products": top_products[:10],
            "category_performance": category_performance[:10],
            "payment_methods": sorted(payment_methods.values(), key=lambda item: item["amount"], reverse=True),
        },
    }
