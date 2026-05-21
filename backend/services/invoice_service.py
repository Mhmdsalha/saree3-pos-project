from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import or_

from models import Invoice, User, Session as CashierSession
from services.timezone_service import local_month_range


def q2(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"))


def q3(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.001"))


def session_last_seen(session: CashierSession):
    return session.last_activity_at or session.opened_at


def ensure_invoice_access(invoice: Invoice, user: User):
    if user.role == "cashier" and invoice.cashier_id != user.id:
        raise HTTPException(403, "لا تملك صلاحية الوصول إلى هذه الفاتورة")


def build_invoice_conditions(user, month=None, status=None, payment_method=None, cashier_id=None):
    conditions = []
    if user.role == "cashier":
        conditions.append(Invoice.cashier_id == user.id)
    elif cashier_id:
        conditions.append(Invoice.cashier_id == cashier_id)
    if month:
        month_start, month_end = local_month_range(month)
        conditions.append(Invoice.created_at >= month_start)
        conditions.append(Invoice.created_at < month_end)
    if status == "paid":
        conditions += [Invoice.is_cancelled == False, Invoice.is_paid == True]
    elif status == "unpaid":
        conditions += [Invoice.is_cancelled == False, Invoice.is_paid == False]
    elif status == "cancelled":
        conditions.append(Invoice.is_cancelled == True)
    if payment_method:
        conditions.append(Invoice.payment_method == payment_method)
    return conditions


def apply_invoice_search(query, search):
    try:
        invoice_id = int(search)
        return query.where(or_(Invoice.id == invoice_id, Invoice.customer_name.ilike(f"%{search}%")))
    except ValueError:
        return query.where(Invoice.customer_name.ilike(f"%{search}%"))


def invoice_to_dict(inv):
    returned_amount = float(inv.returned_amount or 0)
    final_total = float(inv.final_total or 0)
    net_total = float(Decimal(str(max(0.0, final_total - returned_amount))).quantize(Decimal("0.00")))
    return {
        "id": inv.id,
        "cashier_id": inv.cashier_id,
        "cashier_name": inv.cashier.name if inv.cashier else None,
        "customer_name": inv.customer_name,
        "customer_phone": inv.customer_phone,
        "invoice_sent_to_telegram": bool(inv.invoice_sent_to_telegram),
        "invoice_telegram_sent_at": inv.invoice_telegram_sent_at.isoformat() if inv.invoice_telegram_sent_at else None,
        "invoice_telegram_delivery_status": inv.invoice_telegram_delivery_status,
        "payment_method": inv.payment_method,
        "total": float(inv.total or 0),
        "discount": float(inv.discount or 0),
        "final_total": final_total,
        "returned_amount": returned_amount,
        "net_total": net_total,
        "is_cancelled": inv.is_cancelled,
        "is_paid": inv.is_paid,
        "is_returned": bool(inv.is_returned),
        "created_at": inv.created_at.isoformat(),
        "items": [
            {
                "id": item.id,
                "product_id": item.product_id,
                "quantity": float(item.quantity or 0),
                "price": float(item.price or 0),
                "subtotal": float(item.subtotal or 0),
                "product_name": item.product.name if item.product else None,
                "product_barcode": item.product.barcode if item.product else None,
                "product_unit": item.product.unit if item.product else None,
                "product_unit_price": float(item.product.price or 0) if item.product else None,
                "product_is_weighted": bool(item.product.is_weighted) if item.product else None,
            }
            for item in inv.items
        ],
    }


def invoice_to_detail_dict(inv):
    return {
        "id": inv.id,
        "cashier_id": inv.cashier_id,
        "customer_name": inv.customer_name,
        "customer_phone": inv.customer_phone,
        "invoice_sent_to_telegram": bool(inv.invoice_sent_to_telegram),
        "invoice_telegram_sent_at": inv.invoice_telegram_sent_at,
        "invoice_telegram_delivery_status": inv.invoice_telegram_delivery_status,
        "payment_method": inv.payment_method,
        "total": float(inv.total or 0),
        "discount": float(inv.discount or 0),
        "final_total": float(inv.final_total or 0),
        "is_cancelled": inv.is_cancelled,
        "is_paid": inv.is_paid,
        "created_at": inv.created_at,
        "items": [
            {
                "id": item.id,
                "product_id": item.product_id,
                "quantity": float(item.quantity or 0),
                "price": float(item.price or 0),
                "subtotal": float(item.subtotal or 0),
                "product_name": getattr(item.product, "name", None),
                "product_barcode": getattr(item.product, "barcode", None),
                "product_unit": getattr(item.product, "unit", None),
                "product_unit_price": float(getattr(item.product, "price", 0) or 0) if getattr(item, "product", None) else None,
                "product_is_weighted": bool(getattr(item.product, "is_weighted", False)) if getattr(item, "product", None) else None,
            }
            for item in inv.items
        ],
    }
