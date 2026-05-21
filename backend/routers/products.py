"""router: /products/* and /categories/*"""
from datetime import datetime, date, timedelta
import random
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from database import get_db
from models import Category, InvoiceItem, Product, ProductBarcode, ProductBatch, PurchaseItem, StockMovement
from routers.deps import get_current_user, require_manager
from schemas import (
    CategoryCreate,
    CategoryOut,
    PrintableBarcodeOut,
    ProductCreate,
    ProductOut,
    ProductPrepareForSale,
    ProductSetupCandidateOut,
    ProductUpdate,
)
from services.launcher_service import ensure_store_categories, get_store_profile, supports_weighted_products
from services.timezone_service import utc_now


def is_valid_ean13(barcode: str) -> bool:
    value = str(barcode or "").strip()
    if not re.match(r"^\d{13}$", value):
        return False
    total = sum(int(value[index]) * (1 if index % 2 == 0 else 3) for index in range(12))
    return (10 - (total % 10)) % 10 == int(value[12])


def validate_ean13(barcode: str | None, field: str = "الباركود") -> str:
    value = str(barcode or "").strip()
    if not value:
        raise HTTPException(422, f"{field}: الباركود مطلوب")
    if not re.match(r"^\d+$", value):
        raise HTTPException(422, f"{field}: يجب أن يحتوي على أرقام فقط")
    if len(value) != 13:
        raise HTTPException(422, f"{field}: يجب أن يكون 13 رقمًا")
    if not is_valid_ean13(value):
        raise HTTPException(422, f"{field}: باركود EAN-13 غير صالح")
    return value


async def ensure_barcode_available(
    db: AsyncSession,
    barcode: str,
    *,
    current_product_id: int | None = None,
    field_label: str = "الباركود",
):
    clean_barcode = validate_ean13(barcode, field_label)
    product_stmt = select(Product).where(Product.barcode == clean_barcode, Product.is_active == True)
    if current_product_id is not None:
        product_stmt = product_stmt.where(Product.id != current_product_id)
    product_conflict = (await db.execute(product_stmt)).scalar_one_or_none()
    if product_conflict:
        raise HTTPException(400, f"{field_label}: موجود مسبقًا")

    barcode_stmt = (
        select(ProductBarcode)
        .join(Product, Product.id == ProductBarcode.product_id)
        .where(ProductBarcode.barcode == clean_barcode, Product.is_active == True)
    )
    if current_product_id is not None:
        barcode_stmt = barcode_stmt.where(ProductBarcode.product_id != current_product_id)
    barcode_conflict = (await db.execute(barcode_stmt)).scalar_one_or_none()
    if barcode_conflict:
        raise HTTPException(400, f"{field_label}: موجود مسبقًا")
    return clean_barcode


async def replace_extra_barcodes(db: AsyncSession, product: Product, barcodes: list[str]):
    existing = (
        await db.execute(select(ProductBarcode).where(ProductBarcode.product_id == product.id))
    ).scalars().all()
    for extra in existing:
        await db.delete(extra)
    await db.flush()

    for index, barcode in enumerate(barcodes, start=1):
        clean_barcode = await ensure_barcode_available(
            db,
            barcode,
            current_product_id=product.id,
            field_label=f"الباركود الإضافي #{index}",
        )
        if clean_barcode == product.barcode:
            continue
        db.add(ProductBarcode(product_id=product.id, barcode=clean_barcode))


def build_product_query(*, sellable_only: bool):
    query = select(Product).where(Product.is_active == True).options(selectinload(Product.extra_barcodes))
    if sellable_only:
        query = query.where(Product.is_sellable == True)
    return query


async def generate_unique_ean13(db: AsyncSession) -> str:
    while True:
        base = "".join(str(random.randint(0, 9)) for _ in range(12))
        total = sum(int(base[index]) * (1 if index % 2 == 0 else 3) for index in range(12))
        check = (10 - (total % 10)) % 10
        barcode = base + str(check)

        if (await db.execute(select(Product).where(Product.barcode == barcode))).scalar_one_or_none():
            continue
        if (await db.execute(select(ProductBarcode).where(ProductBarcode.barcode == barcode))).scalar_one_or_none():
            continue
        return barcode


async def resolve_product_sale_mode(db: AsyncSession, *, is_weighted: bool, sell_without_barcode: bool) -> tuple[bool, bool]:
    profile = await get_store_profile(db)
    weighted_allowed = supports_weighted_products(getattr(profile, "store_type", None))
    effective_is_weighted = bool(is_weighted) and weighted_allowed
    effective_sell_without_barcode = bool(sell_without_barcode) or (bool(is_weighted) and not weighted_allowed)
    return effective_is_weighted, effective_sell_without_barcode


categories_router = APIRouter(prefix="/categories", tags=["categories"])


@categories_router.get("", response_model=list[CategoryOut])
async def get_categories(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await ensure_store_categories(db)
    result = await db.execute(select(Category))
    return result.scalars().all()


@categories_router.post("", response_model=CategoryOut)
async def create_category(data: CategoryCreate, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    category = Category(**data.dict())
    db.add(category)
    await db.commit()
    await db.refresh(category)
    return category


router = APIRouter(prefix="/products", tags=["products"])


@router.get("/alerts")
async def get_manager_alerts(db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    today = date.today()
    warning_date = today + timedelta(days=7)

    res = await db.execute(select(Product).where(Product.is_active == True))
    products = res.scalars().all()

    alerts = {"out_of_stock": [], "low_stock": [], "expired": [], "near_expiry": []}
    for product in products:
        if product.stock <= 0:
            alerts["out_of_stock"].append({"id": product.id, "name": product.name, "barcode": product.barcode, "stock": product.stock})
        elif product.stock <= product.min_stock:
            alerts["low_stock"].append({"id": product.id, "name": product.name, "barcode": product.barcode, "stock": product.stock, "min": product.min_stock})

        if product.expiry_date:
            exp_date = product.expiry_date.date() if hasattr(product.expiry_date, "date") else product.expiry_date
            if exp_date < today:
                alerts["expired"].append({"id": product.id, "name": product.name, "barcode": product.barcode, "expiry": str(exp_date)})
            elif exp_date <= warning_date:
                alerts["near_expiry"].append({"id": product.id, "name": product.name, "barcode": product.barcode, "expiry": str(exp_date)})

    return {
        "counts": {
            "out_of_stock": len(alerts["out_of_stock"]),
            "low_stock": len(alerts["low_stock"]),
            "expired": len(alerts["expired"]),
            "near_expiry": len(alerts["near_expiry"]),
        },
        "details": alerts,
    }


@router.get("/generate-barcode")
async def generate_barcode(db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    return {"barcode": await generate_unique_ean13(db)}


@router.get("/setup-candidates", response_model=list[ProductSetupCandidateOut])
async def get_setup_candidates(
    q: str | None = None,
    limit: int = 12,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    stmt = (
        select(Product)
        .where(Product.is_active == True)
        .options(selectinload(Product.default_supplier), selectinload(Product.category))
        .order_by(Product.is_sellable.asc(), Product.name.asc())
    )
    clean_q = str(q or "").strip()
    if clean_q:
        like_value = f"%{clean_q}%"
        stmt = stmt.where(
            or_(
                Product.name.ilike(like_value),
                Product.barcode.ilike(like_value),
            )
        )
    rows = (await db.execute(stmt.limit(max(1, min(limit, 30))))).scalars().all()
    return [
        {
            "id": row.id,
            "name": row.name,
            "unit": row.unit,
            "stock": float(row.stock or 0),
            "barcode": row.barcode,
            "supplier_name": getattr(row.default_supplier, "name", None),
            "category_name": getattr(row.category, "name", None),
            "is_weighted": bool(row.is_weighted),
            "is_sellable": bool(row.is_sellable),
            "track_expiry": bool(row.track_expiry),
            "track_batch": bool(row.track_batch),
        }
        for row in rows
    ]


@router.get("", response_model=list[ProductOut])
async def get_products(
    category_id: int | None = None,
    sellable_only: bool = False,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    query = build_product_query(sellable_only=sellable_only)
    if category_id is not None:
        query = query.where(Product.category_id == category_id)
    result = await db.execute(query.order_by(Product.name.asc()))
    return result.scalars().all()


@router.get("/barcode/{barcode}", response_model=ProductOut)
async def get_by_barcode(barcode: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    clean_barcode = validate_ean13(barcode, "الباركود")
    opts = selectinload(Product.extra_barcodes)
    result = await db.execute(
        select(Product).where(
            Product.barcode == clean_barcode,
            Product.is_active == True,
            Product.is_sellable == True,
        ).options(opts)
    )
    product = result.scalar_one_or_none()
    if not product:
        alias = (
            await db.execute(
                select(ProductBarcode)
                .join(Product, Product.id == ProductBarcode.product_id)
                .where(ProductBarcode.barcode == clean_barcode, Product.is_active == True, Product.is_sellable == True)
            )
        ).scalar_one_or_none()
        if alias:
            product = (
                await db.execute(
                    select(Product).where(
                        Product.id == alias.product_id,
                        Product.is_active == True,
                        Product.is_sellable == True,
                    ).options(opts)
                )
            ).scalar_one_or_none()
    if not product:
        raise HTTPException(404, "المنتج غير موجود")
    return product


@router.post("", response_model=ProductOut)
async def create_product(data: ProductCreate, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    effective_is_weighted, effective_sell_without_barcode = await resolve_product_sale_mode(
        db,
        is_weighted=bool(data.is_weighted),
        sell_without_barcode=bool(data.sell_without_barcode),
    )
    primary_barcode = None
    extra_barcodes: list[str] = []
    if not effective_is_weighted and not effective_sell_without_barcode:
        primary_barcode = await ensure_barcode_available(db, data.barcode, field_label="الباركود الأساسي")
        extra_barcodes = [
            await ensure_barcode_available(db, item, field_label=f"الباركود الإضافي ({item})")
            for item in (data.extra_barcodes or [])
        ]

    product = Product(
        barcode=primary_barcode,
        name=data.name,
        name_en=data.name_en,
        category_id=data.category_id,
        default_supplier_id=data.default_supplier_id,
        buy_price=data.buy_price,
        price=data.price,
        stock=data.stock,
        min_stock=data.min_stock,
        unit=data.unit,
        is_weighted=effective_is_weighted,
        is_sellable=data.is_sellable,
        track_expiry=data.track_expiry,
        track_batch=data.track_batch,
        image=data.image,
        expiry_date=data.expiry_date,
    )
    db.add(product)
    await db.flush()

    for extra in extra_barcodes:
        if extra and extra != primary_barcode:
            db.add(ProductBarcode(product_id=product.id, barcode=extra))

    await db.commit()
    return (
        await db.execute(select(Product).where(Product.id == product.id).options(selectinload(Product.extra_barcodes)))
    ).scalar_one()


@router.post("/{product_id}/prepare-for-sale", response_model=ProductOut)
async def prepare_product_for_sale(
    product_id: int,
    data: ProductPrepareForSale,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    product = (await db.execute(select(Product).where(Product.id == product_id, Product.is_active == True))).scalar_one_or_none()
    if not product:
        raise HTTPException(404, "الصنف المخزني غير موجود")

    effective_is_weighted, effective_sell_without_barcode = await resolve_product_sale_mode(
        db,
        is_weighted=bool(data.is_weighted),
        sell_without_barcode=bool(data.sell_without_barcode),
    )

    if data.name is not None:
        product.name = data.name
    product.category_id = data.category_id
    if data.buy_price is not None:
        product.buy_price = data.buy_price
    product.price = data.price
    if data.min_stock is not None:
        product.min_stock = data.min_stock
    if data.unit is not None:
        product.unit = data.unit
    product.is_weighted = effective_is_weighted
    product.track_expiry = data.track_expiry
    product.track_batch = data.track_batch
    product.expiry_date = data.expiry_date
    product.is_sellable = True

    if effective_is_weighted or effective_sell_without_barcode:
        product.barcode = None
        await replace_extra_barcodes(db, product, [])
    else:
        product.barcode = await ensure_barcode_available(
            db,
            data.barcode,
            current_product_id=product.id,
            field_label="الباركود الأساسي",
        )
        await replace_extra_barcodes(db, product, data.extra_barcodes or [])

    product.updated_at = utc_now()
    await db.commit()
    return (
        await db.execute(select(Product).where(Product.id == product.id).options(selectinload(Product.extra_barcodes)))
    ).scalar_one()


@router.post("/{product_id}/printable-barcode", response_model=PrintableBarcodeOut)
async def get_printable_barcode(
    product_id: int,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    product = (
        await db.execute(
            select(Product)
            .where(Product.id == product_id, Product.is_active == True)
            .options(selectinload(Product.extra_barcodes))
        )
    ).scalar_one_or_none()
    if not product:
        raise HTTPException(404, "المنتج غير موجود")
    if not product.is_sellable:
        raise HTTPException(400, "هذا المنتج غير مهيأ للبيع ولا يمكن طباعة باركود له.")
    if product.is_weighted:
        raise HTTPException(400, "المنتجات الموزونة لا تدعم طباعة باركود البيع من هذا المسار.")

    barcode = str(product.barcode or "").strip()
    if not barcode:
        raise HTTPException(400, "طباعة الباركود متاحة فقط للمنتجات العادية التي تملك باركودًا أساسيًا.")

    return {
        "product_id": product.id,
        "product_name": product.name,
        "barcode": barcode,
        "source": "primary",
        "unit": product.unit,
        "price": float(product.price or 0),
        "is_weighted": bool(product.is_weighted),
        "is_sellable": bool(product.is_sellable),
    }


@router.post("/{product_id}/barcodes", response_model=ProductOut)
async def add_product_barcode(product_id: int, barcode: str, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    product = (await db.execute(select(Product).where(Product.id == product_id))).scalar_one_or_none()
    if not product:
        raise HTTPException(404, "المنتج غير موجود")
    if product.is_weighted:
        raise HTTPException(400, "المنتجات الموزونة لا تدعم الباركود أو ربطه")
    clean_barcode = await ensure_barcode_available(db, barcode, current_product_id=product_id)
    if product.barcode == clean_barcode:
        return product
    db.add(ProductBarcode(product_id=product_id, barcode=clean_barcode))
    product.is_sellable = True
    product.updated_at = utc_now()
    await db.commit()
    return (
        await db.execute(select(Product).where(Product.id == product_id).options(selectinload(Product.extra_barcodes)))
    ).scalar_one()


@router.delete("/{product_id}/barcodes/{barcode_id}")
async def delete_product_barcode(product_id: int, barcode_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    product_barcode = (
        await db.execute(select(ProductBarcode).where(ProductBarcode.id == barcode_id, ProductBarcode.product_id == product_id))
    ).scalar_one_or_none()
    if not product_barcode:
        raise HTTPException(404, "الباركود غير موجود")
    await db.delete(product_barcode)
    await db.commit()
    return {"ok": True}


@router.put("/{product_id}", response_model=ProductOut)
async def update_product(product_id: int, data: ProductUpdate, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    product = (await db.execute(select(Product).where(Product.id == product_id))).scalar_one_or_none()
    if not product:
        raise HTTPException(404, "المنتج غير موجود")

    payload = data.dict(exclude_unset=True)
    requested_is_weighted = bool(payload.get("is_weighted", product.is_weighted))
    requested_sell_without_barcode = bool(payload.get("sell_without_barcode", False))
    effective_is_weighted, effective_sell_without_barcode = await resolve_product_sale_mode(
        db,
        is_weighted=requested_is_weighted,
        sell_without_barcode=requested_sell_without_barcode,
    )
    if "is_weighted" in payload:
        payload["is_weighted"] = effective_is_weighted
    if "sell_without_barcode" in payload:
        payload["sell_without_barcode"] = effective_sell_without_barcode

    for key, value in payload.items():
        setattr(product, key, value)

    if effective_is_weighted or effective_sell_without_barcode:
        product.barcode = None
        await replace_extra_barcodes(db, product, [])

    product.updated_at = utc_now()
    await db.commit()
    return (
        await db.execute(select(Product).where(Product.id == product.id).options(selectinload(Product.extra_barcodes)))
    ).scalar_one()


@router.delete("/{product_id}")
async def delete_product(product_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    product = (await db.execute(select(Product).where(Product.id == product_id))).scalar_one_or_none()
    if not product:
        raise HTTPException(404, "المنتج غير موجود")
    has_operational_history = any(
        [
            float(product.stock or 0) > 0,
            (await db.execute(select(PurchaseItem.id).where(PurchaseItem.product_id == product_id).limit(1))).scalar_one_or_none() is not None,
            (await db.execute(select(ProductBatch.id).where(ProductBatch.product_id == product_id).limit(1))).scalar_one_or_none() is not None,
            (await db.execute(select(StockMovement.id).where(StockMovement.product_id == product_id).limit(1))).scalar_one_or_none() is not None,
            (await db.execute(select(InvoiceItem.id).where(InvoiceItem.product_id == product_id).limit(1))).scalar_one_or_none() is not None,
        ]
    )
    if has_operational_history:
        raise HTTPException(
            409,
            "لا يمكن حذف هذا الصنف من صفحة المنتجات لأنه مرتبط بالمخزون أو المشتريات أو الحركات السابقة",
        )

    product.is_active = False
    extra_barcodes = (
        await db.execute(select(ProductBarcode).where(ProductBarcode.product_id == product_id))
    ).scalars().all()
    for extra in extra_barcodes:
        await db.delete(extra)
    await db.commit()
    return {"ok": True}
