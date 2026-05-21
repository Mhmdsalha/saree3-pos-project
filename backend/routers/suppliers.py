from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Purchase, Supplier
from routers.deps import require_manager
from schemas import SupplierCreate, SupplierOut, SupplierUpdate
from services.supplier_service import ensure_supplier_can_be_deactivated, ensure_supplier_name_available

router = APIRouter(prefix="/suppliers", tags=["suppliers"])


@router.get("", response_model=list[SupplierOut])
async def list_suppliers(db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    rows = (await db.execute(select(Supplier).order_by(Supplier.name.asc()))).scalars().all()
    return rows


@router.post("", response_model=SupplierOut)
async def create_supplier(data: SupplierCreate, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    try:
        await ensure_supplier_name_available(db, data.name)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    supplier = Supplier(**data.model_dump())
    db.add(supplier)
    await db.commit()
    await db.refresh(supplier)
    return supplier


@router.get("/{supplier_id}", response_model=SupplierOut)
async def get_supplier(supplier_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    supplier = (await db.execute(select(Supplier).where(Supplier.id == supplier_id))).scalar_one_or_none()
    if not supplier:
        raise HTTPException(404, "المورد غير موجود")
    return supplier


@router.put("/{supplier_id}", response_model=SupplierOut)
async def update_supplier(supplier_id: int, data: SupplierUpdate, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    supplier = (await db.execute(select(Supplier).where(Supplier.id == supplier_id))).scalar_one_or_none()
    if not supplier:
        raise HTTPException(404, "المورد غير موجود")
    payload = data.model_dump(exclude_unset=True)
    if "name" in payload:
        try:
            await ensure_supplier_name_available(db, payload["name"], exclude_id=supplier_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    if payload.get("is_active") is False and supplier.is_active:
        try:
            await ensure_supplier_can_be_deactivated(db, supplier)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    for key, value in payload.items():
        setattr(supplier, key, value)
    await db.commit()
    await db.refresh(supplier)
    return supplier


@router.get("/{supplier_id}/purchases")
async def supplier_purchases(supplier_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    supplier = (await db.execute(select(Supplier).where(Supplier.id == supplier_id))).scalar_one_or_none()
    if not supplier:
        raise HTTPException(404, "المورد غير موجود")
    rows = (
        await db.execute(
            select(Purchase).where(Purchase.supplier_id == supplier_id).order_by(Purchase.purchase_date.desc())
        )
    ).scalars().all()
    return [
        {
            "id": row.id,
            "invoice_number": row.invoice_number,
            "purchase_date": row.purchase_date.isoformat() if row.purchase_date else None,
            "status": row.status,
            "total_amount": float(row.total_amount or 0),
        }
        for row in rows
    ]
