"""router: /reports/*"""
import csv
import io
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from database import get_db
from models import User, Product, Invoice, InvoiceItem, InvoiceReturn, InvoiceReturnItem, Session as CashierSession
from routers.deps import require_manager
from schemas import ReportsDashboardOut
from services.reports_analytics_service import build_reports_dashboard
from services.timezone_service import local_day_range, local_month_range, to_local, utc_now

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/dashboard", response_model=ReportsDashboardOut)
async def reports_dashboard(
    preset: str = "month",
    date_from: str | None = None,
    date_to: str | None = None,
    cashier_id: int | None = None,
    category_id: int | None = None,
    payment_method: str | None = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    try:
        return await build_reports_dashboard(
            db,
            preset=preset,
            date_from=date_from,
            date_to=date_to,
            cashier_id=cashier_id,
            category_id=category_id,
            payment_method=payment_method,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/daily")
async def daily_report(
    date: str | None = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    day_start, day_end = local_day_range(date)
    local_date_str = to_local(day_start).date().isoformat()

    invoices = (await db.execute(
        select(Invoice).where(
            Invoice.is_cancelled == False,
            Invoice.created_at >= day_start,
            Invoice.created_at <  day_end,
        )
    )).scalars().all()

    gross_sales    = round(sum(float(i.final_total or 0) for i in invoices), 2)
    returned_total = round(float((await db.execute(
        select(func.sum(InvoiceReturn.total_refunded))
        .join(Invoice, Invoice.id == InvoiceReturn.original_invoice_id)
        .where(
            Invoice.is_cancelled == False,
            InvoiceReturn.created_at >= day_start,
            InvoiceReturn.created_at < day_end,
        )
    )).scalar() or 0), 2)
    total_sales  = round(gross_sales - returned_total, 2)
    paid_total   = round(sum(float(i.final_total or 0) for i in invoices if i.is_paid), 2)
    unpaid_total = round(sum(float(i.final_total or 0) for i in invoices if not i.is_paid), 2)
    return {
        "date":           local_date_str,
        "gross_sales":    gross_sales,
        "total_sales":    total_sales,
        "paid_total":     paid_total,
        "unpaid_total":   unpaid_total,
        "returned_total": returned_total,
        "invoice_count":  len(invoices),
        "average":        round(total_sales / len(invoices), 2) if invoices else 0,
    }


@router.get("/returns-summary")
async def returns_summary(
    date: str | None = None,
    month: str | None = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    """Ù…Ù„Ø®Øµ Ø§Ù„Ù…Ø±ØªØ¬Ø¹Ø§Øª Ø§Ù„ÙŠÙˆÙ…ÙŠ ÙˆØ§Ù„Ø´Ù‡Ø±ÙŠ"""
    day_start, day_end = local_day_range(date)
    month_start, month_end = local_month_range(month)

    # Ù…Ø±ØªØ¬Ø¹Ø§Øª Ø§Ù„ÙŠÙˆÙ…
    day_returns = (await db.execute(
        select(InvoiceReturn).where(
            InvoiceReturn.created_at >= day_start,
            InvoiceReturn.created_at < day_end,
        )
    )).scalars().all()

    day_total = round(sum(float(r.total_refunded or 0) for r in day_returns), 2)
    day_count = len(day_returns)

    # Ø¹Ø¯Ø¯ Ø§Ù„Ø¨Ù†ÙˆØ¯ Ø§Ù„Ù…ÙØ±Ø¬Ø¹Ø© Ø§Ù„ÙŠÙˆÙ…
    day_items_count = 0
    for r in day_returns:
        items = (await db.execute(
            select(func.sum(InvoiceReturnItem.quantity))
            .where(InvoiceReturnItem.return_id == r.id)
        )).scalar() or 0
        day_items_count += int(items)

    # Ù…Ø±ØªØ¬Ø¹Ø§Øª Ø§Ù„Ø´Ù‡Ø±
    month_returns = (await db.execute(
        select(InvoiceReturn).where(
            InvoiceReturn.created_at >= month_start,
            InvoiceReturn.created_at < month_end,
        )
    )).scalars().all()

    month_total = round(sum(float(r.total_refunded or 0) for r in month_returns), 2)
    month_count = len(month_returns)

    month_items_count = 0
    for r in month_returns:
        items = (await db.execute(
            select(func.sum(InvoiceReturnItem.quantity))
            .where(InvoiceReturnItem.return_id == r.id)
        )).scalar() or 0
        month_items_count += int(items)

    return {
        "day": {
            "total_refunded": day_total,
            "return_count": day_count,
            "items_count": day_items_count,
        },
        "month": {
            "total_refunded": month_total,
            "return_count": month_count,
            "items_count": month_items_count,
        },
    }


@router.get("/cashiers")
async def cashiers_report(
    date: str | None = None,
    month: str | None = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    day_start,   day_end   = local_day_range(date)
    month_start, month_end = local_month_range(month)
    day_str = date or to_local(day_start).date().isoformat()
    month_str = month or to_local(month_start).strftime("%Y-%m")

    users = (await db.execute(select(User).where(User.is_active == True))).scalars().all()

    async def cashier_stats(uid, start, end):
        rows = (await db.execute(
            select(
                func.count(Invoice.id).label("count"),
                func.sum(Invoice.final_total).label("total"),
            ).where(
                Invoice.cashier_id == uid,
                Invoice.is_cancelled == False,
                Invoice.created_at >= start,
                Invoice.created_at <  end,
            )
        )).one()
        returned = (await db.execute(
            select(func.sum(InvoiceReturn.total_refunded))
            .join(Invoice, Invoice.id == InvoiceReturn.original_invoice_id)
            .where(
                Invoice.cashier_id == uid,
                Invoice.is_cancelled == False,
                InvoiceReturn.created_at >= start,
                InvoiceReturn.created_at < end,
            )
        )).scalar()
        gross    = float(rows.total    or 0)
        returned = float(returned or 0)
        return {"count": rows.count or 0, "total": round(gross - returned, 2)}

    result = []
    for u in users:
        day_s   = await cashier_stats(u.id, day_start,   day_end)
        month_s = await cashier_stats(u.id, month_start, month_end)
        result.append({
            "id": u.id, "name": u.name, "username": u.username,
            "cashier_number": u.cashier_number, "role": u.role,
            "day":   {"date":  day_str,   **day_s},
            "month": {"month": month_str, **month_s},
        })

    result.sort(key=lambda x: x["day"]["total"], reverse=True)
    return result


@router.get("/cashiers/export/csv")
async def export_cashiers_csv(
    date: str | None = None,
    month: str | None = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    """ØªØµØ¯ÙŠØ± ØªÙ‚Ø±ÙŠØ± Ø§Ù„ÙƒØ§Ø´ÙŠØ±ÙŠÙ† CSV"""
    data = await cashiers_report(date=date, month=month, db=db, _=None)

    output = io.StringIO()
    output.write('\ufeff')
    writer = csv.writer(output)
    writer.writerow(["Ø§Ù„ÙƒØ§Ø´ÙŠØ±", "Ø§Ù„Ø¯ÙˆØ±", "ÙÙˆØ§ØªÙŠØ± Ø§Ù„ÙŠÙˆÙ…", "Ù…Ø¨ÙŠØ¹Ø§Øª Ø§Ù„ÙŠÙˆÙ…", "ÙÙˆØ§ØªÙŠØ± Ø§Ù„Ø´Ù‡Ø±", "Ù…Ø¨ÙŠØ¹Ø§Øª Ø§Ù„Ø´Ù‡Ø±"])
    for c in data:
        writer.writerow([
            c["name"], c["role"],
            c["day"]["count"],  f"{c['day']['total']:.2f}",
            c["month"]["count"], f"{c['month']['total']:.2f}",
        ])
    output.seek(0)
    fname = f"cashiers_{date or 'today'}_{utc_now().strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/sales-insights")
async def sales_insights(
    date: str | None = None,
    month: str | None = None,
    top_n: int = 10,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    day_start,   day_end   = local_day_range(date)
    month_start, month_end = local_month_range(month)
    day_str = date or to_local(day_start).date().isoformat()
    month_str = month or to_local(month_start).strftime("%Y-%m")

    async def get_top(start, end):
        rows = (await db.execute(
            select(
                Product.id, Product.name, Product.barcode,
                func.sum(InvoiceItem.quantity).label("qty_sold"),
                func.sum(InvoiceItem.subtotal).label("revenue"),
            )
            .join(InvoiceItem, InvoiceItem.product_id == Product.id)
            .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
            .where(Invoice.is_cancelled == False, Invoice.created_at >= start, Invoice.created_at < end)
            .group_by(Product.id, Product.name, Product.barcode)
            .order_by(func.sum(InvoiceItem.quantity).desc())
        )).all()
        return [{"product_id": r.id, "name": r.name, "barcode": r.barcode,
                 "qty_sold": float(r.qty_sold or 0), "revenue": float(r.revenue or 0)} for r in rows]

    day_data   = await get_top(day_start,   day_end)
    month_data = await get_top(month_start, month_end)

    return {
        "day":   {"date":  day_str,   "total_revenue": sum(r["revenue"] for r in day_data),
                  "top": day_data[:top_n], "bottom": list(reversed(day_data))[:top_n] if len(day_data) > top_n else []},
        "month": {"month": month_str, "total_revenue": sum(r["revenue"] for r in month_data),
                  "top": month_data[:top_n], "bottom": list(reversed(month_data))[:top_n] if len(month_data) > top_n else []},
    }


@router.get("/inventory")
async def inventory_report(
    low_stock_only: bool = False,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    """ØªÙ‚Ø±ÙŠØ± Ø§Ù„Ù…Ø®Ø²ÙˆÙ† Ø§Ù„ÙƒØ§Ù…Ù„: Ø§Ù„Ù‚ÙŠÙ…ØŒ Ø§Ù„Ø§Ø­ØµØ§Ø¦ÙŠØ§ØªØŒ ÙˆØ§Ù„Ù†ÙˆØ§Ù‚Øµ"""
    stmt = select(Product).where(Product.is_active == True)
    products = (await db.execute(stmt)).scalars().all()

    items = []
    low_stock_count = 0
    out_of_stock = 0
    total_buy_value = 0.0
    total_sell_value = 0.0

    for p in products:
        is_out = p.stock <= 0
        is_low = not is_out and p.stock <= p.min_stock
        
        if low_stock_only and not (is_out or is_low):
            continue

        if is_out: out_of_stock += 1
        if is_low: low_stock_count += 1
        
        status = "out" if is_out else "low" if is_low else "ok"
        
        buy_val = float(p.buy_price or 0) * float(p.stock or 0)
        sell_val = float(p.price or 0) * float(p.stock or 0)
        
        total_buy_value += buy_val
        total_sell_value += sell_val

        items.append({
            "id": p.id,
            "name": p.name,
            "barcode": p.barcode,
            "stock": p.stock,
            "min_stock": p.min_stock,
            "unit": p.unit or "Ø¨Ù†Ø¯",
            "buy_price": float(p.buy_price or 0),
            "price": float(p.price or 0),
            "buy_value": round(buy_val, 2),
            "sell_value": round(sell_val, 2),
            "status": status,
            "is_low": is_low or is_out
        })

    return {
        "summary": {
            "total_products": len(products),
            "low_stock_count": low_stock_count,
            "out_of_stock": out_of_stock,
            "total_buy_value": round(total_buy_value, 2),
            "total_sell_value": round(total_sell_value, 2),
            "potential_profit": round(total_sell_value - total_buy_value, 2),
        },
        "items": items
    }



@router.get("/expiry")
async def expiry_report(
    days: int = 7,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    now = utc_now()
    threshold = now + timedelta(days=days)
    products = (await db.execute(
        select(Product).where(
            Product.is_active == True,
            Product.expiry_date != None,
            Product.expiry_date <= threshold,
        ).order_by(Product.expiry_date.asc())
    )).scalars().all()

    items = []
    for p in products:
        delta = (p.expiry_date - now).days
        status = "expired" if delta < 0 else "expires_today" if delta == 0 else "critical" if delta <= 3 else "warning"
        items.append({
            "id": p.id, "barcode": p.barcode, "name": p.name, "stock": p.stock,
            "expiry_date": p.expiry_date.isoformat() if p.expiry_date else None,
            "days_left": delta, "status": status,
        })

    return {
        "threshold_days": days, "total": len(items),
        "expired":  sum(1 for i in items if i["status"] == "expired"),
        "critical": sum(1 for i in items if i["status"] == "critical"),
        "warning":  sum(1 for i in items if i["status"] in ("warning", "expires_today")),
        "items": items,
    }


@router.post("/send-telegram")
async def send_telegram_report(
    payload: dict,
    _=Depends(require_manager),
):
    """Ø¥Ø±Ø³Ø§Ù„ Ø±Ø³Ø§Ù„Ø© Ø¹Ø¨Ø± Telegram bot"""
    try:
        from telegram_alerts import send_alert
        message = payload.get("message", "")
        if not message:
            from fastapi import HTTPException
            raise HTTPException(400, "Ø§Ù„Ø±Ø³Ø§Ù„Ø© ÙØ§Ø±ØºØ©")
        ok = await send_alert(message)
        if ok:
            return {"ok": True}
        else:
            from fastapi import HTTPException
            raise HTTPException(503, "ØªØ¹Ø°Ø± Ø§Ù„Ø¥Ø±Ø³Ø§Ù„ â€” ØªØ­Ù‚Ù‚ Ù…Ù† TELEGRAM_BOT_TOKEN Ùˆ TELEGRAM_CHAT_ID ÙÙŠ Ù…Ù„Ù .env")
    except HTTPException:
        raise
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(500, f"Ø®Ø·Ø£: {e}")


@router.get("/employee-activity")
async def employee_activity(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    """ØªÙ‚Ø±ÙŠØ± Ù…Ø±Ø§Ù‚Ø¨Ø© Ø§Ù„Ù…ÙˆØ¸ÙÙŠÙ†: Ø§Ù„Ø¬Ù„Ø³Ø§Øª Ø§Ù„Ù†Ø´Ø·Ø©ØŒ Ø¢Ø®Ø± Ø¸Ù‡ÙˆØ±ØŒ ÙˆØ³Ø§Ø¹Ø§Øª Ø§Ù„Ø¹Ù…Ù„"""
    # Ø¬Ù„Ø¨ Ø¬Ù…ÙŠØ¹ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ† Ø§Ù„Ù†Ø´Ø·ÙŠÙ†
    users = (await db.execute(select(User).where(User.is_active == True))).scalars().all()
    
    result = []
    for u in users:
        # Ø¬Ù„Ø¨ Ø§Ù„Ø¬Ù„Ø³Ø© Ø§Ù„Ø­Ø§Ù„ÙŠØ© (Ø§Ù„Ù†Ø´Ø·Ø© Ø£ÙˆÙ„Ø§Ù‹) Ø£Ùˆ Ø¢Ø®Ø± Ø¬Ù„Ø³Ø©
        session_res = await db.execute(
            select(CashierSession)
            .where(CashierSession.user_id == u.id)
            .order_by(CashierSession.is_active.desc(), CashierSession.opened_at.desc())
            .limit(1)
        )
        s = session_res.scalar_one_or_none()
        
        status = "offline"
        last_seen = None
        working_hours = 0.0
        invoices_count = 0
        total_sales = 0.0
        opened_at = None
        
        if s:
            opened_at = s.opened_at
            last_seen = s.last_activity_at or s.opened_at
            invoices_count = s.invoices_count or 0
            total_sales = float(s.total_sales or 0)
            if s.is_active:
                status = "online"
                if (utc_now() - last_seen).total_seconds() > 300:
                    status = "idle"

                duration = utc_now() - s.opened_at
                working_hours = round(duration.total_seconds() / 3600, 2)
            else:
                if s.closed_at:
                    duration = s.closed_at - s.opened_at
                    working_hours = round(duration.total_seconds() / 3600, 2)
        
        result.append({
            "id": u.id,
            "name": u.name,
            "username": u.username,
            "role": u.role,
            "status": status,
            "last_activity": to_local(last_seen).isoformat() if last_seen else None,
            "opened_at": to_local(opened_at).isoformat() if opened_at else None,
            "working_hours": working_hours,
            "invoices_count": invoices_count,
            "total_sales": total_sales,
        })
        
    return result
