from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from models import InvoiceItem, InvoiceItemBatchAllocation, Product, ProductBatch, StockMovement
from services.timezone_service import local_day_range, utc_now


def q3(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.001"))


def q2(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"))


def repair_mojibake_text(value: str | None) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None

    # Repair historical strings that were stored as UTF-8 bytes decoded with latin-1/cp1252.
    if not any(marker in text for marker in ("Ø", "Ù", "Ã")):
        return text

    try:
        raw_bytes = bytearray()
        for char in text:
            codepoint = ord(char)
            if codepoint <= 0xFF:
                raw_bytes.append(codepoint)
                continue
            raw_bytes.extend(char.encode("cp1252"))
        repaired = bytes(raw_bytes).decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError, ValueError):
        return text
    return repaired or text


def normalize_product_quantity(product: Product, quantity, *, label: str = "الكمية") -> Decimal:
    normalized = q3(quantity)
    if not product.is_weighted and normalized != normalized.to_integral_value():
        raise HTTPException(400, f"{label} للمنتج '{product.name}' يجب أن تكون رقمًا صحيحًا")
    return normalized


def set_product_stock_value(product: Product, value) -> None:
    normalized = q3(value)
    if product.is_weighted:
        product.stock = float(normalized)
        return

    if normalized == normalized.to_integral_value():
        product.stock = int(normalized)
    else:
        # Preserve any legacy fractional drift instead of truncating it silently.
        product.stock = float(normalized)


def serialize_product_quantity(product: Product, value):
    normalized = q3(value)
    if product.is_weighted or normalized != normalized.to_integral_value():
        return float(normalized)
    return int(normalized)


async def create_stock_movement(
    db: AsyncSession,
    *,
    product_id: int,
    movement_type: str,
    quantity,
    reference_type: str,
    reference_id: int | None,
    created_by: int | None,
    batch_id: int | None = None,
    unit_cost=None,
    reason: str | None = None,
):
    movement = StockMovement(
        product_id=product_id,
        batch_id=batch_id,
        movement_type=movement_type,
        quantity=q3(quantity),
        unit_cost=q2(unit_cost) if unit_cost is not None else None,
        reference_type=reference_type,
        reference_id=reference_id,
        created_by=created_by,
        reason=reason,
    )
    db.add(movement)
    return movement


def apply_quantity_to_product(product: Product, quantity, increase: bool):
    current = q3(product.stock)
    delta = normalize_product_quantity(product, quantity)
    next_value = current + delta if increase else current - delta
    set_product_stock_value(product, next_value)


async def allocate_invoice_item_batches(
    db: AsyncSession,
    *,
    product: Product,
    invoice_item: InvoiceItem,
    quantity,
    reference_id: int,
    created_by: int | None,
    unit_cost=None,
    reason: str | None = None,
) -> bool:
    remaining = q3(quantity)
    if remaining <= 0:
        return False

    batches = (
        await db.execute(
            select(ProductBatch)
            .where(ProductBatch.product_id == product.id, ProductBatch.available_quantity > 0)
            .order_by(ProductBatch.expiry_date.asc().nulls_last(), ProductBatch.received_at.asc(), ProductBatch.id.asc())
        )
    ).scalars().all()
    if not batches:
        return False

    total_available = sum(q3(batch.available_quantity) for batch in batches)
    if total_available < remaining:
        raise HTTPException(
            409,
            f"دفعات المنتج '{product.name}' غير كافية لتغطية البيع الحالي. راجع المخزون والدفعات قبل المتابعة",
        )

    for batch in batches:
        if remaining <= 0:
            break

        batch_available = q3(batch.available_quantity)
        if batch_available <= 0:
            continue

        allocated = min(remaining, batch_available)
        batch.available_quantity = float(q3(batch_available - allocated))
        if q3(batch.available_quantity) <= 0:
            batch.status = "depleted"

        db.add(
            InvoiceItemBatchAllocation(
                invoice_item_id=invoice_item.id,
                batch_id=batch.id,
                quantity=allocated,
                returned_quantity=Decimal("0.000"),
            )
        )
        await create_stock_movement(
            db,
            product_id=product.id,
            batch_id=batch.id,
            movement_type="sale",
            quantity=allocated,
            unit_cost=unit_cost,
            reference_type="invoice",
            reference_id=reference_id,
            created_by=created_by,
            reason=reason,
        )
        remaining = q3(remaining - allocated)

    return True


async def restore_invoice_item_batches(
    db: AsyncSession,
    *,
    invoice_item: InvoiceItem,
    quantity,
    reference_id: int,
    created_by: int | None,
    unit_cost=None,
    reason: str | None = None,
) -> bool:
    allocations = sorted(
        list(invoice_item.batch_allocations or []),
        key=lambda row: (row.created_at or datetime.min, row.id or 0),
    )
    if not allocations:
        return False

    remaining = q3(quantity)
    for allocation in allocations:
        if remaining <= 0:
            break

        batch = allocation.batch
        if not batch:
            continue

        allocated_qty = q3(allocation.quantity)
        already_returned = q3(allocation.returned_quantity)
        restorable = q3(allocated_qty - already_returned)
        if restorable <= 0:
            continue

        restored = min(remaining, restorable)
        batch.available_quantity = float(q3(batch.available_quantity) + restored)
        if q3(batch.available_quantity) > 0 and batch.status == "depleted":
            batch.status = "active"
        allocation.returned_quantity = float(q3(already_returned + restored))

        await create_stock_movement(
            db,
            product_id=invoice_item.product_id,
            batch_id=batch.id,
            movement_type="sale_return",
            quantity=restored,
            unit_cost=unit_cost,
            reference_type="return",
            reference_id=reference_id,
            created_by=created_by,
            reason=reason,
        )
        remaining = q3(remaining - restored)

    if remaining > 0:
        raise HTTPException(
            409,
            f"تعذر إعادة كمية المرتجع إلى دفعات الصنف '{invoice_item.product.name if invoice_item.product else invoice_item.product_id}' بالكامل",
        )

    return True


async def build_inventory_overview(db: AsyncSession):
    products = (
        await db.execute(
            select(Product)
            .where(Product.is_active == True)
            .options(selectinload(Product.default_supplier), selectinload(Product.category))
            .order_by(Product.name.asc())
        )
    ).scalars().all()

    low_stock = 0
    out_of_stock = 0
    buy_total = 0.0
    sell_total = 0.0
    items = []

    for product in products:
        is_out = float(product.stock or 0) <= 0
        is_low = not is_out and float(product.stock or 0) <= float(product.min_stock or 0)
        if is_out:
            out_of_stock += 1
        elif is_low:
            low_stock += 1

        buy_value = float(product.buy_price or 0) * float(product.stock or 0)
        sell_value = float(product.price or 0) * float(product.stock or 0)
        buy_total += buy_value
        sell_total += sell_value

        items.append(
            {
                "id": product.id,
                "barcode": product.barcode,
                "name": product.name,
                "category_id": product.category_id,
                "category_name": getattr(product.category, "name", None),
                "supplier_id": product.default_supplier_id,
                "supplier_name": getattr(product.default_supplier, "name", None),
                "stock": serialize_product_quantity(product, product.stock),
                "min_stock": serialize_product_quantity(product, product.min_stock),
                "unit": product.unit or "قطعة",
                "buy_price": float(product.buy_price or 0),
                "price": float(product.price or 0),
                "buy_value": round(buy_value, 2),
                "sell_value": round(sell_value, 2),
                "track_expiry": bool(product.track_expiry),
                "track_batch": bool(product.track_batch),
                "is_sellable": bool(product.is_sellable),
                "status": "out" if is_out else "low" if is_low else "ok",
            }
        )

    return {
        "summary": {
            "total_products": len(products),
            "low_stock_count": low_stock,
            "out_of_stock": out_of_stock,
            "total_buy_value": round(buy_total, 2),
            "total_sell_value": round(sell_total, 2),
            "potential_profit": round(sell_total - buy_total, 2),
        },
        "items": items,
    }


async def build_batches_overview(db: AsyncSession, product_id: int | None = None, limit: int | None = 500):
    stmt = (
        select(ProductBatch)
        .options(selectinload(ProductBatch.product), selectinload(ProductBatch.supplier))
        .order_by(ProductBatch.expiry_date.asc().nulls_last(), ProductBatch.received_at.desc())
    )
    if product_id:
        stmt = stmt.where(ProductBatch.product_id == product_id)
    elif limit:
        stmt = stmt.limit(max(1, min(int(limit), 2000)))
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {
            "id": row.id,
            "product_id": row.product_id,
            "product_name": getattr(row.product, "name", None),
            "supplier_name": getattr(row.supplier, "name", None),
            "batch_number": row.batch_number,
            "expiry_date": row.expiry_date.isoformat() if row.expiry_date else None,
            "received_quantity": float(row.received_quantity or 0),
            "available_quantity": float(row.available_quantity or 0),
            "purchase_price": float(row.purchase_price or 0),
            "selling_price": float(row.selling_price or 0) if row.selling_price is not None else None,
            "status": row.status,
            "received_at": row.received_at.isoformat() if row.received_at else None,
        }
        for row in rows
    ]


async def build_stock_movements(
    db: AsyncSession,
    *,
    product_id: int | None = None,
    movement_type: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int | None = 300,
):
    stmt = (
        select(StockMovement)
        .options(selectinload(StockMovement.product), selectinload(StockMovement.batch))
        .order_by(StockMovement.created_at.desc())
    )
    if product_id:
        stmt = stmt.where(StockMovement.product_id == product_id)
    if movement_type:
        stmt = stmt.where(StockMovement.movement_type == movement_type)
    if date_from:
        start, _ = local_day_range(date_from)
        stmt = stmt.where(StockMovement.created_at >= start)
    if date_to:
        _, end = local_day_range(date_to)
        stmt = stmt.where(StockMovement.created_at < end)
    if limit:
        stmt = stmt.limit(max(1, min(int(limit), 1000)))

    rows = (await db.execute(stmt)).scalars().all()
    return [
        {
            "id": row.id,
            "product_id": row.product_id,
            "product_name": getattr(row.product, "name", None),
            "batch_id": row.batch_id,
            "batch_number": getattr(row.batch, "batch_number", None),
            "movement_type": row.movement_type,
            "quantity": float(row.quantity or 0),
            "unit_cost": float(row.unit_cost or 0) if row.unit_cost is not None else None,
            "reference_type": row.reference_type,
            "reference_id": row.reference_id,
            "reason": repair_mojibake_text(row.reason),
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        for row in rows
    ]


async def build_near_expiry(db: AsyncSession, days: int = 30):
    now = utc_now()
    threshold = now + timedelta(days=days)
    rows = (
        await db.execute(
            select(ProductBatch)
            .where(ProductBatch.expiry_date != None, ProductBatch.expiry_date <= threshold)
            .options(selectinload(ProductBatch.product))
            .order_by(ProductBatch.expiry_date.asc())
        )
    ).scalars().all()

    items = []
    for row in rows:
        delta = (row.expiry_date - now).days if row.expiry_date else None
        status = "expired" if delta is not None and delta < 0 else "warning"
        items.append(
            {
                "batch_id": row.id,
                "product_id": row.product_id,
                "product_name": getattr(row.product, "name", None),
                "batch_number": row.batch_number,
                "expiry_date": row.expiry_date.isoformat() if row.expiry_date else None,
                "available_quantity": float(row.available_quantity or 0),
                "days_left": delta,
                "status": status,
            }
        )
    return items


async def product_system_quantity(db: AsyncSession, product_id: int, batch_id: int | None = None):
    if batch_id:
        batch = (
            await db.execute(
                select(ProductBatch).where(ProductBatch.id == batch_id, ProductBatch.product_id == product_id)
            )
        ).scalar_one_or_none()
        return float(batch.available_quantity or 0) if batch else 0.0
    product = (await db.execute(select(Product).where(Product.id == product_id))).scalar_one_or_none()
    if not product:
        return 0.0
    return serialize_product_quantity(product, product.stock)
