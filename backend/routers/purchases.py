from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Purchase, PurchaseItem
from routers.deps import require_manager
from schemas import PurchaseCreate, PurchaseUpdate
from services.purchase_service import confirm_purchase, create_purchase_draft, get_purchase, update_purchase_draft

router = APIRouter(prefix="/purchases", tags=["purchases"])


def _purchase_to_dict(purchase: Purchase):
    return {
        "id": purchase.id,
        "supplier_id": purchase.supplier_id,
        "supplier_name": getattr(purchase.supplier, "name", None),
        "invoice_number": purchase.invoice_number,
        "purchase_date": purchase.purchase_date.isoformat() if purchase.purchase_date else None,
        "status": purchase.status,
        "subtotal": float(purchase.subtotal or 0),
        "discount_amount": float(purchase.discount_amount or 0),
        "total_amount": float(purchase.total_amount or 0),
        "notes": purchase.notes,
        "created_by": purchase.created_by,
        "confirmed_by": purchase.confirmed_by,
        "confirmed_at": purchase.confirmed_at.isoformat() if purchase.confirmed_at else None,
        "created_at": purchase.created_at.isoformat() if purchase.created_at else None,
        "updated_at": purchase.updated_at.isoformat() if purchase.updated_at else None,
        "items": [
            {
                "id": item.id,
                "product_id": item.product_id,
                "product_name": getattr(item.product, "name", None),
                "unit": getattr(item.product, "unit", None),
                "is_sellable": bool(getattr(item.product, "is_sellable", False)),
                "quantity": float(item.quantity or 0),
                "purchase_price": float(item.purchase_price or 0),
                "selling_price": float(item.selling_price or 0) if item.selling_price is not None else None,
                "line_total": float(item.line_total or 0),
                "expiry_date": item.expiry_date.isoformat() if item.expiry_date else None,
                "batch_number": item.batch_number,
                "notes": item.notes,
            }
            for item in purchase.items
        ],
    }


@router.get("")
async def list_purchases(
    status: str | None = None,
    supplier_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    stmt = select(Purchase).order_by(Purchase.purchase_date.desc())
    if status:
        stmt = stmt.where(Purchase.status == status)
    if supplier_id:
        stmt = stmt.where(Purchase.supplier_id == supplier_id)
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {
            "id": row.id,
            "supplier_id": row.supplier_id,
            "invoice_number": row.invoice_number,
            "purchase_date": row.purchase_date.isoformat() if row.purchase_date else None,
            "status": row.status,
            "subtotal": float(row.subtotal or 0),
            "discount_amount": float(row.discount_amount or 0),
            "total_amount": float(row.total_amount or 0),
        }
        for row in rows
    ]


@router.post("")
async def create_purchase(data: PurchaseCreate, db: AsyncSession = Depends(get_db), user=Depends(require_manager)):
    purchase = await create_purchase_draft(db, data, user.id)
    return _purchase_to_dict(purchase)


@router.get("/{purchase_id}")
async def get_purchase_details(purchase_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    purchase = await get_purchase(db, purchase_id)
    if not purchase:
        raise HTTPException(404, "فاتورة الشراء غير موجودة")
    return _purchase_to_dict(purchase)


@router.put("/{purchase_id}")
async def update_purchase(purchase_id: int, data: PurchaseUpdate, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    purchase = await update_purchase_draft(db, purchase_id, data)
    return _purchase_to_dict(purchase)


@router.post("/{purchase_id}/confirm")
async def confirm_purchase_endpoint(purchase_id: int, db: AsyncSession = Depends(get_db), user=Depends(require_manager)):
    purchase = await confirm_purchase(db, purchase_id, user.id)
    return _purchase_to_dict(purchase)


@router.post("/{purchase_id}/cancel")
async def cancel_purchase(purchase_id: int, db: AsyncSession = Depends(get_db), user=Depends(require_manager)):
    purchase = await get_purchase(db, purchase_id)
    if not purchase:
        raise HTTPException(404, "فاتورة الشراء غير موجودة")
    if purchase.status == "confirmed":
        raise HTTPException(400, "لا يمكن إلغاء فاتورة شراء مؤكدة")
    purchase.status = "cancelled"
    await db.commit()
    return {"ok": True}
