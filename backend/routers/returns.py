from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from database import get_db
from models import (
    Invoice,
    InvoiceItem,
    InvoiceItemBatchAllocation,
    InvoiceReturn,
    InvoiceReturnItem,
    Product,
)
from routers.deps import get_current_user
from schemas import ReturnCreate, ReturnOut
from services.inventory_service import (
    apply_quantity_to_product,
    create_stock_movement,
    normalize_product_quantity,
    restore_invoice_item_batches,
)

router = APIRouter(prefix="/returns", tags=["returns"])


def _ensure_invoice_access(invoice: Invoice, user):
    if user.role == "cashier" and invoice.cashier_id != user.id:
        raise HTTPException(403, "?? ???? ?????? ?????? ??? ??????? ??? ????????")


async def _load_invoice(db: AsyncSession, invoice_id: int):
    return (
        await db.execute(
            select(Invoice)
            .where(Invoice.id == invoice_id)
            .options(
                selectinload(Invoice.items).selectinload(InvoiceItem.product),
                selectinload(Invoice.items)
                .selectinload(InvoiceItem.batch_allocations)
                .selectinload(InvoiceItemBatchAllocation.batch),
            )
        )
    ).scalar_one_or_none()


async def _returned_quantity_for_item(db: AsyncSession, invoice_id: int, invoice_item_id: int) -> float:
    value = (
        await db.execute(
            select(func.sum(InvoiceReturnItem.quantity))
            .join(InvoiceReturn, InvoiceReturn.id == InvoiceReturnItem.return_id)
            .where(
                InvoiceReturn.original_invoice_id == invoice_id,
                InvoiceReturnItem.invoice_item_id == invoice_item_id,
            )
        )
    ).scalar()
    return float(value or 0)


@router.post("", response_model=ReturnOut)
async def create_return(data: ReturnCreate, db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    invoice = await _load_invoice(db, data.invoice_id)
    if not invoice:
        raise HTTPException(404, "الفاتورة غير موجودة")
    _ensure_invoice_access(invoice, user)
    if invoice.is_cancelled:
        raise HTTPException(400, "لا يمكن إرجاع فاتورة ملغاة")

    items_map = {item.id: item for item in invoice.items}
    if not data.items:
        raise HTTPException(400, "يجب تحديد بند واحد على الأقل")

    total_refunded = 0.0
    prepared_items = []
    requested_quantities: dict[int, float] = {}

    for item in data.items:
        requested_quantities[item.invoice_item_id] = requested_quantities.get(item.invoice_item_id, 0.0) + float(item.quantity)

    for invoice_item_id, requested_quantity in requested_quantities.items():
        original = items_map.get(invoice_item_id)
        if not original:
            raise HTTPException(404, f"Invoice item #{invoice_item_id} was not found on this invoice")
            raise HTTPException(404, f"البند #{item.invoice_item_id} غير موجود في الفاتورة")

        quantity = float(requested_quantity)
        if quantity <= 0:
            raise HTTPException(400, "كمية الإرجاع يجب أن تكون أكبر من صفر")

        sold_qty = float(original.quantity or 0)
        already_returned = await _returned_quantity_for_item(db, data.invoice_id, invoice_item_id)
        remaining = max(0.0, sold_qty - already_returned)
        if quantity > remaining:
            raise HTTPException(
                400,
                f"كمية الإرجاع ({quantity}) أكبر من المتبقي ({remaining}) للمنتج '{original.product.name if original.product else original.product_id}'",
            )

        product = (await db.execute(select(Product).where(Product.id == original.product_id))).scalar_one_or_none()
        if not product:
            raise HTTPException(404, f"المنتج غير موجود: {original.product_id}")

        quantity_decimal = normalize_product_quantity(product, quantity, label="كمية الإرجاع")
        quantity = float(quantity_decimal)
        apply_quantity_to_product(product, quantity_decimal, True)

        subtotal = round(float(original.price or 0) * quantity, 2)
        total_refunded += subtotal
        prepared_items.append(
            {
                "original_item": original,
                "invoice_item_id": invoice_item_id,
                "product_id": original.product_id,
                "quantity": quantity,
                "price": float(original.price or 0),
                "unit_cost": float(product.buy_price or 0),
                "subtotal": subtotal,
            }
        )

    invoice.returned_amount = float(invoice.returned_amount or 0) + round(total_refunded, 2)
    if invoice.returned_amount >= float(invoice.final_total or 0):
        invoice.is_returned = True

    ret = InvoiceReturn(
        original_invoice_id=data.invoice_id,
        cashier_id=user.id,
        total_refunded=round(total_refunded, 2),
        reason=data.reason,
        refund_method=data.refund_method,
    )
    db.add(ret)
    await db.flush()

    for item in prepared_items:
        original_item = item.pop("original_item")
        unit_cost = item.pop("unit_cost")
        db.add(InvoiceReturnItem(return_id=ret.id, **item))
        restored_batches = await restore_invoice_item_batches(
            db,
            invoice_item=original_item,
            quantity=item["quantity"],
            reference_id=ret.id,
            created_by=user.id,
            unit_cost=unit_cost,
            reason=data.reason or f"إرجاع على الفاتورة #{data.invoice_id}",
        )
        if not restored_batches:
            await create_stock_movement(
                db,
                product_id=item["product_id"],
                movement_type="sale_return",
                quantity=item["quantity"],
                unit_cost=unit_cost,
                reference_type="return",
                reference_id=ret.id,
                created_by=user.id,
                reason=data.reason or f"إرجاع على الفاتورة #{data.invoice_id}",
            )

    await db.commit()

    ret = (
        await db.execute(
            select(InvoiceReturn)
            .where(InvoiceReturn.id == ret.id)
            .options(selectinload(InvoiceReturn.items).selectinload(InvoiceReturnItem.product))
        )
    ).scalar_one()

    return {
        "id": ret.id,
        "original_invoice_id": ret.original_invoice_id,
        "cashier_id": ret.cashier_id,
        "total_refunded": float(ret.total_refunded or 0),
        "reason": ret.reason,
        "refund_method": ret.refund_method,
        "created_at": ret.created_at,
        "items": [
            {
                "id": row.id,
                "product_id": row.product_id,
                "product_name": row.product.name if row.product else None,
                "quantity": float(row.quantity or 0),
                "price": float(row.price or 0),
                "subtotal": float(row.subtotal or 0),
            }
            for row in ret.items
        ],
    }


@router.get("/invoice/{invoice_id}")
async def get_invoice_returns(invoice_id: int, db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    invoice = (await db.execute(select(Invoice).where(Invoice.id == invoice_id))).scalar_one_or_none()
    if not invoice:
        raise HTTPException(404, "???????? ??? ??????")
    _ensure_invoice_access(invoice, user)

    rows = (
        await db.execute(
            select(InvoiceReturn)
            .where(InvoiceReturn.original_invoice_id == invoice_id)
            .options(selectinload(InvoiceReturn.items).selectinload(InvoiceReturnItem.product))
            .order_by(InvoiceReturn.created_at.desc())
        )
    ).scalars().all()

    return [
        {
            "id": row.id,
            "original_invoice_id": row.original_invoice_id,
            "cashier_id": row.cashier_id,
            "total_refunded": float(row.total_refunded or 0),
            "reason": row.reason,
            "refund_method": row.refund_method,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "items": [
                {
                    "id": item.id,
                    "invoice_item_id": item.invoice_item_id,
                    "product_id": item.product_id,
                    "product_name": item.product.name if item.product else None,
                    "quantity": float(item.quantity or 0),
                    "price": float(item.price or 0),
                    "subtotal": float(item.subtotal or 0),
                }
                for item in row.items
            ],
        }
        for row in rows
    ]
