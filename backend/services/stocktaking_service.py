from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from models import Product, ProductBatch, StockCount, StockCountItem
from services.inventory_service import (
    apply_quantity_to_product,
    create_stock_movement,
    normalize_product_quantity,
    product_system_quantity,
    q3,
)
from services.timezone_service import utc_now


async def get_stock_count(db: AsyncSession, count_id: int):
    return (
        await db.execute(
            select(StockCount)
            .where(StockCount.id == count_id)
            .options(selectinload(StockCount.items).selectinload(StockCountItem.product), selectinload(StockCount.items).selectinload(StockCountItem.batch))
        )
    ).scalar_one_or_none()


async def _prepare_count_item(db: AsyncSession, item):
    product = (await db.execute(select(Product).where(Product.id == item.product_id))).scalar_one_or_none()
    if not product:
        raise HTTPException(404, f"Product not found: {item.product_id}")

    counted_quantity = normalize_product_quantity(product, item.counted_quantity, label="counted quantity")
    if counted_quantity < 0:
        raise HTTPException(400, "Counted quantity cannot be negative")

    if item.batch_id:
        batch = (
            await db.execute(
                select(ProductBatch).where(ProductBatch.id == item.batch_id, ProductBatch.product_id == item.product_id)
            )
        ).scalar_one_or_none()
        if not batch:
            raise HTTPException(404, f"Batch #{item.batch_id} was not found for product #{item.product_id}")

    system_quantity = await product_system_quantity(db, item.product_id, item.batch_id)
    difference_quantity = float(q3(counted_quantity - q3(system_quantity)))
    return float(counted_quantity), float(system_quantity), difference_quantity


async def create_stock_count(db: AsyncSession, data, user_id: int):
    stock_count = StockCount(
        count_type=data.count_type,
        status="draft",
        count_date=data.count_date,
        notes=data.notes,
        created_by=user_id,
    )
    db.add(stock_count)
    await db.flush()

    for item in data.items:
        counted_quantity, system_quantity, difference_quantity = await _prepare_count_item(db, item)
        db.add(
            StockCountItem(
                stock_count_id=stock_count.id,
                product_id=item.product_id,
                batch_id=item.batch_id,
                system_quantity=system_quantity,
                counted_quantity=counted_quantity,
                difference_quantity=difference_quantity,
                adjustment_reason=item.adjustment_reason,
                notes=item.notes,
            )
        )

    await db.commit()
    return await get_stock_count(db, stock_count.id)


async def update_stock_count(db: AsyncSession, count_id: int, data):
    stock_count = await get_stock_count(db, count_id)
    if not stock_count:
        raise HTTPException(404, "جلسة الجرد غير موجودة")
    if stock_count.status != "draft":
        raise HTTPException(400, "لا يمكن تعديل جلسة جرد غير مسودة")

    if data.notes is not None:
        stock_count.notes = data.notes
    if data.items is not None:
        stock_count.items.clear()
        await db.flush()
        for item in data.items:
            counted_quantity, system_quantity, difference_quantity = await _prepare_count_item(db, item)
            db.add(
                StockCountItem(
                    stock_count_id=stock_count.id,
                    product_id=item.product_id,
                    batch_id=item.batch_id,
                    system_quantity=system_quantity,
                    counted_quantity=counted_quantity,
                    difference_quantity=difference_quantity,
                    adjustment_reason=item.adjustment_reason,
                    notes=item.notes,
                )
            )
    stock_count.updated_at = utc_now()
    await db.commit()
    return await get_stock_count(db, stock_count.id)


async def submit_stock_count(db: AsyncSession, count_id: int):
    stock_count = await get_stock_count(db, count_id)
    if not stock_count:
        raise HTTPException(404, "جلسة الجرد غير موجودة")
    if stock_count.status != "draft":
        raise HTTPException(400, "يمكن إرسال الجرد من حالة المسودة فقط")
    stock_count.status = "submitted"
    stock_count.updated_at = utc_now()
    await db.commit()
    return await get_stock_count(db, stock_count.id)


async def approve_stock_count(db: AsyncSession, count_id: int, approver_id: int):
    stock_count = await get_stock_count(db, count_id)
    if not stock_count:
        raise HTTPException(404, "جلسة الجرد غير موجودة")
    if stock_count.status != "submitted":
        raise HTTPException(400, "لا يمكن اعتماد الجرد قبل إرساله")

    for item in stock_count.items:
        diff = None
        if diff == 0:
            continue

        product = (await db.execute(select(Product).where(Product.id == item.product_id))).scalar_one_or_none()
        if not product:
            raise HTTPException(404, f"المنتج غير موجود: {item.product_id}")

        counted_quantity = normalize_product_quantity(product, item.counted_quantity, label="counted quantity")
        current_system_quantity = await product_system_quantity(db, item.product_id, item.batch_id)
        diff = float(q3(counted_quantity - q3(current_system_quantity)))
        item.system_quantity = current_system_quantity
        item.counted_quantity = float(counted_quantity)
        item.difference_quantity = diff
        if diff == 0:
            continue

        movement_type = "adjustment_in" if diff > 0 else "adjustment_out"
        apply_quantity_to_product(product, abs(diff), diff > 0)

        if item.batch_id:
            batch = (await db.execute(select(ProductBatch).where(ProductBatch.id == item.batch_id))).scalar_one_or_none()
            if batch:
                next_batch_quantity = float(q3(q3(batch.available_quantity) + q3(diff)))
                if next_batch_quantity < 0:
                    raise HTTPException(400, f"Batch #{item.batch_id} stock cannot become negative")
                batch.available_quantity = next_batch_quantity

        await create_stock_movement(
            db,
            product_id=item.product_id,
            batch_id=item.batch_id,
            movement_type=movement_type,
            quantity=abs(diff),
            unit_cost=product.buy_price,
            reference_type="stock_count",
            reference_id=stock_count.id,
            created_by=approver_id,
            reason=item.adjustment_reason or "اعتماد جرد مخزني",
        )

    stock_count.status = "approved"
    stock_count.approved_by = approver_id
    stock_count.approved_at = utc_now()
    stock_count.updated_at = utc_now()
    await db.commit()
    return await get_stock_count(db, stock_count.id)
