"""router: /invoices/* و /sessions/*"""
import csv
import io
import uuid
import asyncio
import secrets
from datetime import datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func as sqlfunc, and_
from sqlalchemy.orm import selectinload

from database import get_db
from models import Customer, Invoice, InvoiceItem, Product, Session as CashierSession, User
from auth import create_access_token
from schemas import InvoiceCreate, InvoiceOut, SessionOut
from routers.deps import get_current_user, require_manager
import telegram_alerts
from services.customer_telegram_service import get_or_create_customer, normalize_phone_number
from services.inventory_service import (
    allocate_invoice_item_batches,
    apply_quantity_to_product,
    create_stock_movement,
    normalize_product_quantity,
)
from services.invoice_service import (
    apply_invoice_search as svc_apply_invoice_search,
    build_invoice_conditions as svc_build_invoice_conditions,
    ensure_invoice_access as svc_ensure_invoice_access,
    invoice_to_detail_dict,
    invoice_to_dict as svc_invoice_to_dict,
    q2 as svc_q2,
    q3 as svc_q3,
    session_last_seen as svc_session_last_seen,
)
from services.invoice_pdf import build_invoice_pdf
from services.launcher_service import get_store_branding
from services.timezone_service import to_local, utc_now

if not hasattr(telegram_alerts, "_BOT_TOKEN"):
    telegram_alerts._BOT_TOKEN = ""

_SESSION_STALE_SECONDS = 300
_MOBILE_BOOTSTRAP_TTL_MINUTES = 5


sessions_router = APIRouter(prefix="/sessions", tags=["sessions"])

@sessions_router.post("/open", response_model=SessionOut)
async def open_session(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    existing = (await db.execute(
        select(CashierSession).where(CashierSession.user_id == user.id, CashierSession.is_active == True)
    )).scalar_one_or_none()
    if existing:
        last_seen = svc_session_last_seen(existing)
        if last_seen and (utc_now() - last_seen).total_seconds() > _SESSION_STALE_SECONDS:
            existing.is_active = False
            existing.closed_at = last_seen
            existing.disconnect_reason = "timeout"
            existing.is_abnormal = True
            await db.commit()
        else:
            return existing
    session = CashierSession(
        user_id=user.id,
        session_token=str(uuid.uuid4()),
        last_activity_at=None,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session

@sessions_router.post("/close")
async def close_session(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    session = (await db.execute(
        select(CashierSession).where(CashierSession.user_id == user.id, CashierSession.is_active == True)
    )).scalar_one_or_none()
    if session:
        session.is_active = False
        session.closed_at = utc_now()
        session.disconnect_reason = "manual_close"
        session.is_abnormal = False
        session.mobile_bootstrap_token = None
        session.mobile_bootstrap_expires_at = None
        await db.commit()
    return {"ok": True}


@sessions_router.post("/mobile-bootstrap")
async def create_mobile_bootstrap(
    session_token: str = Body(..., embed=True),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    session = (
        await db.execute(
            select(CashierSession).where(
                CashierSession.user_id == user.id,
                CashierSession.session_token == session_token,
                CashierSession.is_active == True,
            )
        )
    ).scalar_one_or_none()
    if not session:
        raise HTTPException(404, "جلسة الكاشير غير موجودة أو لم تعد نشطة")

    now = utc_now()
    session.mobile_bootstrap_token = secrets.token_urlsafe(24)
    session.mobile_bootstrap_expires_at = now + timedelta(minutes=_MOBILE_BOOTSTRAP_TTL_MINUTES)
    session.last_activity_at = now
    await db.commit()
    return {
        "bootstrap_token": session.mobile_bootstrap_token,
        "expires_at": session.mobile_bootstrap_expires_at.isoformat() if session.mobile_bootstrap_expires_at else None,
    }


@sessions_router.post("/mobile-bootstrap/consume")
async def consume_mobile_bootstrap(
    bootstrap_token: str = Body(..., embed=True),
    db: AsyncSession = Depends(get_db),
):
    token = str(bootstrap_token or "").strip()
    if not token:
        raise HTTPException(400, "رمز الربط غير صالح")

    row = (
        await db.execute(
            select(CashierSession, User)
            .join(User, User.id == CashierSession.user_id)
            .where(
                CashierSession.mobile_bootstrap_token == token,
                CashierSession.is_active == True,
            )
        )
    ).first()

    if not row:
        raise HTTPException(404, "طلب ربط الجوال غير موجود أو تم استخدامه")

    session, user = row
    now = utc_now()
    if not user.is_active:
        session.mobile_bootstrap_token = None
        session.mobile_bootstrap_expires_at = None
        await db.commit()
        raise HTTPException(403, "الحساب موقوف")

    if not session.mobile_bootstrap_expires_at or session.mobile_bootstrap_expires_at < now:
        session.mobile_bootstrap_token = None
        session.mobile_bootstrap_expires_at = None
        await db.commit()
        raise HTTPException(410, "انتهت صلاحية طلب ربط الجوال")

    access_token = create_access_token({"sub": str(user.id), "role": user.role})
    session.mobile_bootstrap_token = None
    session.mobile_bootstrap_expires_at = None
    session.last_activity_at = now
    await db.commit()
    return {
        "access_token": access_token,
        "session_token": session.session_token,
        "user": {
            "id": user.id,
            "username": user.username,
            "name": user.name,
            "role": user.role,
            "phone": user.phone,
            "cashier_number": user.cashier_number,
            "is_active": user.is_active,
        },
    }


# ── Invoices ──────────────────────────────────────────────────────────────────
router = APIRouter(prefix="/invoices", tags=["invoices"])
VALID_PAYMENT_METHODS = {"cash", "card", "digital"}




@router.get("")
async def get_invoices(
    page: int = 1, size: int = 50,
    month: str | None = None, status: str | None = None,
    payment_method: str | None = None, cashier_id: int | None = None,
    search: str | None = None,
    db: AsyncSession = Depends(get_db), user=Depends(get_current_user),
):
    size = min(size, 200)
    offset = (page - 1) * size
    opts = [selectinload(Invoice.items).selectinload(InvoiceItem.product), selectinload(Invoice.cashier)]
    conditions = svc_build_invoice_conditions(user, month, status, payment_method, cashier_id)

    count_q = select(sqlfunc.count(Invoice.id))
    data_q  = select(Invoice).options(*opts).order_by(Invoice.created_at.desc())

    if conditions:
        count_q = count_q.where(and_(*conditions))
        data_q  = data_q.where(and_(*conditions))
    if search:
        count_q = svc_apply_invoice_search(count_q, search)
        data_q  = svc_apply_invoice_search(data_q,  search)

    total_count = (await db.execute(count_q)).scalar_one()
    invoices    = (await db.execute(data_q.offset(offset).limit(size))).scalars().all()

    return {
        "items":    [svc_invoice_to_dict(inv) for inv in invoices],
        "total":    total_count,
        "page":     page,
        "size":     size,
        "pages":    (total_count + size - 1) // size if total_count else 1,
        "has_next": page * size < total_count,
        "has_prev": page > 1,
    }


@router.get("/export/csv")
async def export_invoices_csv(
    month: str | None = None,
    status: str | None = None,
    payment_method: str | None = None,
    cashier_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_manager),
):
    """تصدير الفواتير كملف CSV — للمدير والمشرف فقط"""
    opts = [selectinload(Invoice.items).selectinload(InvoiceItem.product),
            selectinload(Invoice.cashier)]
    conditions = svc_build_invoice_conditions(user, month, status, payment_method, cashier_id)

    data_q = select(Invoice).options(*opts).order_by(Invoice.created_at.desc())
    if conditions:
        data_q = data_q.where(and_(*conditions))

    invoices = (await db.execute(data_q)).scalars().all()

    # ── بناء CSV ──────────────────────────────────────────────────────────────
    output = io.StringIO()
    # BOM لدعم Excel مع Arabic
    output.write('\ufeff')
    writer = csv.writer(output)

    # الهيدر
    writer.writerow([
        "رقم الفاتورة", "التاريخ", "الوقت", "الكاشير", "العميل", "الهاتف",
        "طريقة الدفع", "المجموع", "الخصم", "الإجمالي",
        "مدفوعة", "ملغاة", "المنتجات",
    ])

    pay_map = {"cash": "نقدي", "card": "بطاقة", "digital": "رقمي"}

    for inv in invoices:
        products_summary = " | ".join(
            f"{it.product.name if it.product else f'#{it.product_id}'} ×{float(it.quantity or 0):.1f}"
            for it in inv.items
        )
        # تحويل التوقيت UTC → محلي
        local_dt = to_local(inv.created_at) or inv.created_at
        date_str   = local_dt.strftime("%Y-%m-%d")   # 2025-03-21
        time_str   = local_dt.strftime("%H:%M:%S")   # 14:30:00
        writer.writerow([
            inv.id,
            date_str,
            time_str,
            inv.cashier.name if inv.cashier else "—",
            inv.customer_name or "—",
            inv.customer_phone or "—",
            pay_map.get(inv.payment_method, inv.payment_method),
            f"{float(inv.total or 0):.2f}",
            f"{float(inv.discount or 0):.2f}",
            f"{float(inv.final_total or 0):.2f}",
            "نعم" if inv.is_paid      else "لا",
            "نعم" if inv.is_cancelled else "لا",
            products_summary,
        ])

    output.seek(0)
    filename = f"invoices_{month or 'all'}_{utc_now().strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{invoice_id}/send-customer-telegram")
async def send_invoice_to_customer(
    invoice_id: int,
    chat_id: str,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    raise HTTPException(
        410,
        "تم إيقاف هذا المسار القديم. استخدم إرسال PDF عبر تيليجرام بعد تفعيل العميل.",
    )


@router.post("/{invoice_id}/send-telegram-pdf")
async def send_invoice_pdf_to_customer(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    invoice = (
        await db.execute(
            select(Invoice)
            .where(Invoice.id == invoice_id)
            .options(selectinload(Invoice.items).selectinload(InvoiceItem.product), selectinload(Invoice.cashier))
        )
    ).scalar_one_or_none()
    if not invoice:
        raise HTTPException(404, "الفاتورة غير موجودة")

    svc_ensure_invoice_access(invoice, user)

    if not invoice.customer_phone:
        raise HTTPException(400, "رقم هاتف العميل غير متوفر على الفاتورة")

    customer = (
        await db.execute(select(Customer).where(Customer.phone_number == normalize_phone_number(invoice.customer_phone)))
    ).scalar_one_or_none()
    if not customer or not customer.telegram_chat_id or customer.telegram_activation_status != "activated":
        raise HTTPException(400, "هذا العميل غير مفعل على تيليجرام بعد")

    payload = svc_invoice_to_dict(invoice)
    branding = await get_store_branding(db)
    currency_label = str(branding.get("currency") or "").strip() or "ر.س"
    pdf_bytes = build_invoice_pdf(payload, branding=branding)
    ok = await telegram_alerts.send_document_to_chat(
        customer.telegram_chat_id,
        f"invoice-{invoice.id}.pdf",
        pdf_bytes,
        f"فاتورتك رقم #{invoice.id} بقيمة {float(invoice.final_total or 0):.2f} {currency_label}",
    )

    invoice.invoice_sent_to_telegram = bool(ok)
    invoice.invoice_telegram_sent_at = utc_now() if ok else None
    invoice.invoice_telegram_delivery_status = "sent" if ok else "failed"
    await db.commit()

    if not ok:
        raise HTTPException(503, "تعذر إرسال ملف الفاتورة عبر تيليجرام")

    return {
        "ok": True,
        "invoice_id": invoice.id,
        "sent_at": invoice.invoice_telegram_sent_at.isoformat() if invoice.invoice_telegram_sent_at else None,
        "status": invoice.invoice_telegram_delivery_status,
    }


@router.post("/sync")
async def sync_offline_invoices(
    data_list: list[InvoiceCreate],
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """مزامنة مجموعة فواتير (أوفلاين) دفعة واحدة"""
    results = []
    for data in data_list:
        try:
            res = await create_invoice(data=data, db=db, user=user)
            results.append({"status": "ok", "offline_uuid": data.offline_uuid, "id": res["id"]})
        except HTTPException as e:
            results.append({"status": "error", "offline_uuid": data.offline_uuid, "detail": e.detail})
        except Exception as e:
            results.append({"status": "error", "offline_uuid": data.offline_uuid, "detail": str(e)})
    return results


@router.post("")
async def create_invoice(
    data: InvoiceCreate,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    # ── التحقق من تكرار الفاتورة (الأوفلاين) ──
    if data.offline_uuid:
        existing_offline = (
            await db.execute(
                select(Invoice)
                .where(Invoice.offline_uuid == data.offline_uuid)
                .options(
                    selectinload(Invoice.items).selectinload(InvoiceItem.product),
                    selectinload(Invoice.cashier),
                )
            )
        ).scalar_one_or_none()
        if existing_offline:
            return svc_invoice_to_dict(existing_offline)

    try:
        if not data.items:
            raise HTTPException(400, "يجب إضافة بند واحد على الأقل إلى الفاتورة")

        payment_method = str(data.payment_method or "cash").strip().lower()
        if payment_method not in VALID_PAYMENT_METHODS:
            raise HTTPException(400, "طريقة الدفع غير صالحة")

        product_ids = [item.product_id for item in data.items]
        products_map = {
            p.id: p for p in (await db.execute(
                select(Product).where(Product.id.in_(product_ids), Product.is_active == True)
            )).scalars().all()
        }
        prepared_items: list[dict[str, object]] = []
        requested_by_product: dict[int, Decimal] = {}

        for item in data.items:
            p = products_map.get(item.product_id)
            if not p:
                raise HTTPException(404, f"المنتج #{item.product_id} غير موجود أو غير نشط")
            if not p.is_sellable:
                raise HTTPException(400, f"المنتج '{p.name}' غير جاهز للبيع")
            if p.is_weighted:
                unit_price = svc_q2(p.price)
                final_price = svc_q2(item.price)
                if unit_price <= 0:
                    raise HTTPException(400, f"سعر الوحدة للمنتج '{p.name}' غير صالح")
                if final_price <= 0:
                    raise HTTPException(400, f"السعر النهائي للمنتج '{p.name}' يجب أن يكون أكبر من صفر")
                quantity = svc_q3(final_price / unit_price)
                if quantity <= 0:
                    raise HTTPException(400, f"تعذر احتساب الكمية المباعة للمنتج '{p.name}'")
                requested_by_product[p.id] = svc_q3(requested_by_product.get(p.id, Decimal("0")) + quantity)
                prepared_items.append({
                    "product": p,
                    "product_id": item.product_id,
                    "quantity": quantity,
                    "unit_price": unit_price,
                    "subtotal": final_price,
                })
                continue
            quantity = normalize_product_quantity(p, item.quantity, label="كمية البيع")
            if quantity <= 0:
                raise HTTPException(400, f"كمية البيع للمنتج '{p.name}' يجب أن تكون أكبر من صفر")
            requested_by_product[p.id] = svc_q3(requested_by_product.get(p.id, Decimal("0")) + quantity)

            prepared_items.append({
                "product": p,
                "product_id": item.product_id,
                "quantity": quantity,
                "unit_price": svc_q2(p.price),
                "subtotal": svc_q2(svc_q2(p.price) * quantity),
            })

        for product_id, requested_quantity in requested_by_product.items():
            p = products_map[product_id]
            available_stock = svc_q3(p.stock)
            if available_stock < requested_quantity:
                raise HTTPException(
                    400,
                    f"مخزون '{p.name}' غير كافٍ — متوفر: {float(available_stock):.3f}، مطلوب: {float(requested_quantity):.3f}",
                )

        discount = float(svc_q2(data.discount or 0))
        total = float(svc_q2(sum(Decimal(str(entry["subtotal"])) for entry in prepared_items)))
        if discount < 0:
            raise HTTPException(400, "الخصم لا يمكن أن يكون سالبًا")
        if discount > total:
            raise HTTPException(400, "الخصم لا يمكن أن يكون أكبر من إجمالي الفاتورة")
        final = float(svc_q2(max(0.0, total - discount)))

        invoice = Invoice(
            cashier_id=user.id,
            customer_name=data.customer_name, customer_phone=data.customer_phone,
            payment_method=payment_method,
            total=total, discount=discount, final_total=final,
            notes=data.notes, is_paid=data.is_paid,
            offline_uuid=data.offline_uuid,
        )
        if data.customer_phone:
            customer = await get_or_create_customer(
                db,
                customer_name=data.customer_name,
                phone_number=data.customer_phone,
            )
            invoice.customer_name = customer.customer_name or data.customer_name
            invoice.customer_phone = customer.phone_number
        db.add(invoice)
        await db.flush()

        for prepared in prepared_items:
            p = prepared["product"]
            unit_price = float(prepared["unit_price"])
            quantity = float(prepared["quantity"])
            subtotal = float(prepared["subtotal"])
            invoice_item = InvoiceItem(
                invoice_id=invoice.id, product_id=int(prepared["product_id"]),
                quantity=quantity, price=unit_price,
                subtotal=subtotal,
            )
            db.add(invoice_item)
            await db.flush()
            apply_quantity_to_product(p, quantity, False)
            used_batch_allocations = await allocate_invoice_item_batches(
                db,
                product=p,
                invoice_item=invoice_item,
                quantity=quantity,
                reference_id=invoice.id,
                created_by=user.id,
                unit_cost=p.buy_price,
                reason=f"بيع عبر الفاتورة #{invoice.id}",
            )
            if not used_batch_allocations:
                await create_stock_movement(
                db,
                product_id=p.id,
                movement_type="sale",
                quantity=quantity,
                unit_cost=p.buy_price,
                reference_type="invoice",
                reference_id=invoice.id,
                created_by=user.id,
                reason=f"بيع عبر الفاتورة #{invoice.id}",
            )

        # ── تحديث إحصائيات الجلسة ──
        session_res = await db.execute(
            select(CashierSession).where(CashierSession.user_id == user.id, CashierSession.is_active == True)
        )
        session = session_res.scalar_one_or_none()
        if session:
            session.invoices_count = (session.invoices_count or 0) + 1
            session.total_sales    = (session.total_sales or 0) + Decimal(str(final))
            session.last_activity_at = utc_now()

        await db.commit()

        # ── إشعارات Telegram للمخزون المنخفض (بعد الـ commit) ─────────────────
        try:
            for p in products_map.values():
                stock = float(p.stock or 0)
                min_stock = float(p.min_stock or 0)
                if stock <= 0:
                    asyncio.create_task(telegram_alerts.alert_out_of_stock(p.name, p.barcode))
                elif stock <= min_stock:
                    asyncio.create_task(telegram_alerts.alert_low_stock(p.name, p.barcode, stock, min_stock))
            # إشعار فاتورة كبيرة
            cashier_name = user.name if hasattr(user, 'name') else str(user.id)
            asyncio.create_task(telegram_alerts.alert_large_invoice(invoice.id, float(invoice.final_total or 0), cashier_name))

            # ── الإرسال التلقائي للفاتورة بناءً على الإعدادات ──
            auto_send = await telegram_alerts.get_system_setting("telegram_auto_send_invoices", "false")
            if auto_send and auto_send.lower() == "true":
                items_summary = "\n".join([
                    f"▫️ {products_map[it.product_id].name} ×{it.quantity} ="
                    f" {float(Decimal(str(float(products_map[it.product_id].price) * float(it.quantity))).quantize(Decimal('0.00')))}"
                    for it in data.items
                ])
                asyncio.create_task(telegram_alerts.alert_invoice_details(
                    invoice.id, float(invoice.final_total), cashier_name,
                    items_summary, invoice.customer_name
                ))

        except Exception:
            pass  # الإشعارات اختيارية — لا توقف عملية البيع

    except HTTPException:
        await db.rollback(); raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(500, f"خطأ في إنشاء الفاتورة: {exc}")

    inv = (await db.execute(
        select(Invoice).where(Invoice.id == invoice.id)
        .options(selectinload(Invoice.items).selectinload(InvoiceItem.product))
    )).scalar_one()

    return {
        "id": inv.id, "cashier_id": inv.cashier_id,
        "customer_name": inv.customer_name, "customer_phone": inv.customer_phone,
        "invoice_sent_to_telegram": bool(inv.invoice_sent_to_telegram),
        "invoice_telegram_sent_at": inv.invoice_telegram_sent_at,
        "invoice_telegram_delivery_status": inv.invoice_telegram_delivery_status,
        "payment_method": inv.payment_method,
        "total": float(inv.total or 0), "discount": float(inv.discount or 0),
        "final_total": float(inv.final_total or 0),
        "is_cancelled": inv.is_cancelled, "is_paid": inv.is_paid,
        "created_at": inv.created_at,
        "items": [{
            "id": it.id, "product_id": it.product_id,
            "quantity": float(it.quantity or 0), "price": float(it.price or 0),
            "subtotal": float(it.subtotal or 0),
            "product_name":    it.product.name    if it.product else None,
            "product_barcode": it.product.barcode if it.product else None,
            "product_unit": it.product.unit if it.product else None,
            "product_unit_price": float(it.product.price or 0) if it.product else None,
            "product_is_weighted": bool(it.product.is_weighted) if it.product else None,
        } for it in inv.items],
    }


@router.get("/{invoice_id}", response_model=InvoiceOut)
async def get_invoice(invoice_id: int, db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    inv = (await db.execute(
        select(Invoice).where(Invoice.id == invoice_id)
        .options(selectinload(Invoice.items).selectinload(InvoiceItem.product))
    )).scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "الفاتورة غير موجودة")
    svc_ensure_invoice_access(inv, user)
    return invoice_to_detail_dict(inv)


@router.put("/{invoice_id}/pay")
async def mark_invoice_paid(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    inv = (await db.execute(select(Invoice).where(Invoice.id == invoice_id))).scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "الفاتورة غير موجودة")
    svc_ensure_invoice_access(inv, user)
    inv.is_paid = True
    await db.commit()
    return {"ok": True}
