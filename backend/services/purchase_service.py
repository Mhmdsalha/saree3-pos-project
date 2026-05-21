from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from models import Product, ProductBatch, Purchase, PurchaseItem, Supplier
from services.inventory_service import apply_quantity_to_product, create_stock_movement
from services.launcher_service import get_store_profile, supports_weighted_products
from services.timezone_service import utc_now


def money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"))


def qty(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.001"))


async def _validate_purchase_items(db: AsyncSession, items):
    product_ids = [item.product_id for item in items if item.product_id]
    products_map: dict[int, Product] = {}
    if product_ids:
        products = (
            await db.execute(select(Product).where(Product.id.in_(product_ids), Product.is_active == True))
        ).scalars().all()
        products_map = {product.id: product for product in products}
        missing = [product_id for product_id in product_ids if product_id not in products_map]
        if missing:
            raise HTTPException(404, f"المنتجات غير موجودة أو غير نشطة: {missing}")

    for item in items:
        product = products_map.get(item.product_id)
        if not product:
            continue
        if product.track_expiry and not item.expiry_date:
            raise HTTPException(422, f"يجب إدخال تاريخ انتهاء للمنتج: {product.name}")
        if product.track_batch and not (item.batch_number or "").strip():
            raise HTTPException(422, f"يجب إدخال رقم دفعة للمنتج: {product.name}")
    return products_map


async def _create_stock_only_product(db: AsyncSession, item, supplier_id: int) -> Product:
    product_name = str(item.product_name or "").strip()
    stock_unit = str(item.unit or "").strip() or "قطعة"
    if not product_name:
        raise HTTPException(422, "اسم الصنف الجديد مطلوب")

    profile = await get_store_profile(db)
    effective_is_weighted = bool(item.is_weighted) and supports_weighted_products(getattr(profile, "store_type", None))

    product = Product(
        barcode=None,
        name=product_name,
        category_id=item.category_id,
        default_supplier_id=supplier_id,
        buy_price=money(item.purchase_price),
        price=money(item.selling_price) if item.selling_price is not None else Decimal("0.00"),
        stock=Decimal("0.000"),
        min_stock=qty(item.min_stock),
        unit=stock_unit,
        is_weighted=effective_is_weighted,
        is_sellable=False,
        track_expiry=bool(item.track_expiry),
        track_batch=bool(item.track_batch),
        expiry_date=item.expiry_date if item.track_expiry else None,
    )
    db.add(product)
    await db.flush()
    item.product_id = product.id
    return product


async def _resolve_purchase_products(db: AsyncSession, supplier_id: int, items):
    products_map = await _validate_purchase_items(db, items)
    created_cache: dict[tuple, Product] = {}
    for item in items:
        if item.product_id:
            continue
        cache_key = (
            str(item.product_name or "").strip().lower(),
            str(item.unit or "").strip().lower(),
            int(item.category_id or 0),
            bool(item.is_weighted),
            bool(item.track_expiry),
            bool(item.track_batch),
        )
        product = created_cache.get(cache_key)
        if not product:
            product = await _create_stock_only_product(db, item, supplier_id)
            created_cache[cache_key] = product
        else:
            item.product_id = product.id
        products_map[product.id] = product
    return products_map


def _build_purchase_totals(items, discount_amount):
    subtotal = money(sum(float(item.purchase_price) * float(item.quantity) for item in items))
    discount = money(discount_amount)
    total = money(max(Decimal("0.00"), subtotal - discount))
    return subtotal, discount, total


async def create_purchase_draft(db: AsyncSession, data, user_id: int):
    supplier = (await db.execute(select(Supplier).where(Supplier.id == data.supplier_id, Supplier.is_active == True))).scalar_one_or_none()
    if not supplier:
        raise HTTPException(404, "المورد غير موجود أو غير نشط")
    await _resolve_purchase_products(db, data.supplier_id, data.items)
    subtotal, discount, total = _build_purchase_totals(data.items, data.discount_amount)

    purchase = Purchase(
        supplier_id=data.supplier_id,
        invoice_number=data.invoice_number,
        purchase_date=data.purchase_date,
        status="draft",
        subtotal=subtotal,
        discount_amount=discount,
        total_amount=total,
        notes=data.notes,
        created_by=user_id,
    )
    db.add(purchase)
    await db.flush()

    for item in data.items:
        db.add(
            PurchaseItem(
                purchase_id=purchase.id,
                product_id=item.product_id,
                quantity=qty(item.quantity),
                purchase_price=money(item.purchase_price),
                selling_price=money(item.selling_price) if item.selling_price is not None else None,
                line_total=money(float(item.purchase_price) * float(item.quantity)),
                expiry_date=item.expiry_date,
                batch_number=(item.batch_number or "").strip() or None,
                notes=item.notes,
            )
        )

    await db.commit()
    return await get_purchase(db, purchase.id)


async def get_purchase(db: AsyncSession, purchase_id: int):
    purchase = (
        await db.execute(
            select(Purchase)
            .where(Purchase.id == purchase_id)
            .options(selectinload(Purchase.items).selectinload(PurchaseItem.product), selectinload(Purchase.supplier))
        )
    ).scalar_one_or_none()
    return purchase


async def update_purchase_draft(db: AsyncSession, purchase_id: int, data):
    purchase = await get_purchase(db, purchase_id)
    if not purchase:
        raise HTTPException(404, "فاتورة الشراء غير موجودة")
    if purchase.status != "draft":
        raise HTTPException(400, "لا يمكن تعديل فاتورة شراء غير مسودة")

    target_supplier_id = data.supplier_id if data.supplier_id is not None else purchase.supplier_id
    items_payload = data.items if data.items is not None else [
        type(
            "ExistingPurchaseItem",
            (),
            {
                "product_id": item.product_id,
                "product_name": getattr(item.product, "name", None),
                "unit": getattr(item.product, "unit", None),
                "category_id": getattr(item.product, "category_id", None),
                "min_stock": float(getattr(item.product, "min_stock", 5) or 5),
                "is_weighted": bool(getattr(item.product, "is_weighted", False)),
                "track_expiry": bool(getattr(item.product, "track_expiry", False)),
                "track_batch": bool(getattr(item.product, "track_batch", False)),
                "quantity": float(item.quantity or 0),
                "purchase_price": float(item.purchase_price or 0),
                "selling_price": float(item.selling_price or 0) if item.selling_price is not None else None,
                "expiry_date": item.expiry_date,
                "batch_number": item.batch_number,
                "notes": item.notes,
            },
        )
        for item in purchase.items
    ]
    await _resolve_purchase_products(db, target_supplier_id, items_payload)

    if data.supplier_id is not None:
        supplier = (
            await db.execute(select(Supplier).where(Supplier.id == data.supplier_id, Supplier.is_active == True))
        ).scalar_one_or_none()
        if not supplier:
            raise HTTPException(404, "المورد غير موجود أو غير نشط")
        purchase.supplier_id = data.supplier_id
    if data.invoice_number is not None:
        purchase.invoice_number = data.invoice_number
    if data.purchase_date is not None:
        purchase.purchase_date = data.purchase_date
    if data.notes is not None:
        purchase.notes = data.notes

    if data.items is not None:
        purchase.items.clear()
        await db.flush()
        for item in data.items:
            purchase.items.append(
                PurchaseItem(
                    product_id=item.product_id,
                    quantity=qty(item.quantity),
                    purchase_price=money(item.purchase_price),
                    selling_price=money(item.selling_price) if item.selling_price is not None else None,
                    line_total=money(float(item.purchase_price) * float(item.quantity)),
                    expiry_date=item.expiry_date,
                    batch_number=(item.batch_number or "").strip() or None,
                    notes=item.notes,
                )
            )

    subtotal, discount, total = _build_purchase_totals(
        items_payload,
        data.discount_amount if data.discount_amount is not None else purchase.discount_amount,
    )
    purchase.subtotal = subtotal
    purchase.discount_amount = money(data.discount_amount) if data.discount_amount is not None else purchase.discount_amount
    purchase.total_amount = total
    purchase.updated_at = utc_now()
    await db.commit()
    return await get_purchase(db, purchase.id)


async def confirm_purchase(db: AsyncSession, purchase_id: int, user_id: int):
    purchase = await get_purchase(db, purchase_id)
    if not purchase:
        raise HTTPException(404, "فاتورة الشراء غير موجودة")
    if purchase.status != "draft":
        raise HTTPException(400, "لا يمكن تأكيد فاتورة الشراء في حالتها الحالية")

    for item in purchase.items:
        product = item.product
        if not product:
            raise HTTPException(404, f"المنتج غير موجود: {item.product_id}")

        apply_quantity_to_product(product, item.quantity, True)
        if not product.default_supplier_id:
            product.default_supplier_id = purchase.supplier_id
        product.buy_price = money(item.purchase_price)
        if item.selling_price is not None:
            product.price = money(item.selling_price)
        if product.track_expiry and item.expiry_date:
            product.expiry_date = item.expiry_date

        batch = None
        if product.track_expiry or product.track_batch or item.batch_number or item.expiry_date:
            batch = ProductBatch(
                product_id=product.id,
                purchase_item_id=item.id,
                supplier_id=purchase.supplier_id,
                batch_number=item.batch_number,
                expiry_date=item.expiry_date,
                received_quantity=qty(item.quantity),
                available_quantity=qty(item.quantity),
                purchase_price=money(item.purchase_price),
                selling_price=money(item.selling_price) if item.selling_price is not None else None,
                received_at=purchase.purchase_date,
                status="active",
            )
            db.add(batch)
            await db.flush()

        await create_stock_movement(
            db,
            product_id=product.id,
            batch_id=batch.id if batch else None,
            movement_type="purchase",
            quantity=item.quantity,
            unit_cost=item.purchase_price,
            reference_type="purchase",
            reference_id=purchase.id,
            created_by=user_id,
            reason=f"شراء من المورد #{purchase.supplier_id}",
        )

    purchase.status = "confirmed"
    purchase.confirmed_by = user_id
    purchase.confirmed_at = utc_now()
    purchase.updated_at = utc_now()
    await db.commit()
    return await get_purchase(db, purchase.id)
