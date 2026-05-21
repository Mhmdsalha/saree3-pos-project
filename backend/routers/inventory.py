from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import StockCount
from routers.deps import require_manager
from schemas import StockCountCreate, StockCountUpdate
from services.inventory_service import (
    build_batches_overview,
    build_inventory_overview,
    build_near_expiry,
    build_stock_movements,
)
from services.stocktaking_service import approve_stock_count, create_stock_count, get_stock_count, submit_stock_count, update_stock_count

router = APIRouter(prefix="/inventory", tags=["inventory"])


def _stock_count_to_dict(stock_count: StockCount):
    return {
        "id": stock_count.id,
        "count_type": stock_count.count_type,
        "status": stock_count.status,
        "count_date": stock_count.count_date.isoformat() if stock_count.count_date else None,
        "notes": stock_count.notes,
        "created_by": stock_count.created_by,
        "approved_by": stock_count.approved_by,
        "approved_at": stock_count.approved_at.isoformat() if stock_count.approved_at else None,
        "created_at": stock_count.created_at.isoformat() if stock_count.created_at else None,
        "updated_at": stock_count.updated_at.isoformat() if stock_count.updated_at else None,
        "items": [
            {
                "id": item.id,
                "product_id": item.product_id,
                "product_name": getattr(item.product, "name", None),
                "batch_id": item.batch_id,
                "batch_number": getattr(item.batch, "batch_number", None),
                "system_quantity": float(item.system_quantity or 0),
                "counted_quantity": float(item.counted_quantity or 0),
                "difference_quantity": float(item.difference_quantity or 0),
                "adjustment_reason": item.adjustment_reason,
                "notes": item.notes,
            }
            for item in stock_count.items
        ],
    }


@router.get("/overview")
async def inventory_overview(db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    return await build_inventory_overview(db)


@router.get("/stock")
async def inventory_stock(db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    data = await build_inventory_overview(db)
    return data["items"]


@router.get("/batches")
async def inventory_batches(
    product_id: int | None = None,
    limit: int = 500,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    return await build_batches_overview(db, product_id=product_id, limit=limit)


@router.get("/movements")
async def inventory_movements(
    product_id: int | None = None,
    movement_type: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 300,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    return await build_stock_movements(
        db,
        product_id=product_id,
        movement_type=movement_type,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
    )


@router.get("/low-stock")
async def low_stock_items(db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    data = await build_inventory_overview(db)
    return [item for item in data["items"] if item["status"] in {"low", "out"}]


@router.get("/near-expiry")
async def near_expiry_items(days: int = 30, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    return await build_near_expiry(db, days=days)


@router.get("/counts")
async def list_stock_counts(db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    rows = (await db.execute(select(StockCount).order_by(StockCount.count_date.desc()))).scalars().all()
    return [
        {
            "id": row.id,
            "count_type": row.count_type,
            "status": row.status,
            "count_date": row.count_date.isoformat() if row.count_date else None,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        for row in rows
    ]


@router.post("/counts")
async def create_count(data: StockCountCreate, db: AsyncSession = Depends(get_db), user=Depends(require_manager)):
    stock_count = await create_stock_count(db, data, user.id)
    return _stock_count_to_dict(stock_count)


@router.get("/counts/{count_id}")
async def get_count(count_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    stock_count = await get_stock_count(db, count_id)
    if not stock_count:
        raise HTTPException(404, "جلسة الجرد غير موجودة")
    return _stock_count_to_dict(stock_count)


@router.put("/counts/{count_id}")
async def update_count(count_id: int, data: StockCountUpdate, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    stock_count = await update_stock_count(db, count_id, data)
    return _stock_count_to_dict(stock_count)


@router.post("/counts/{count_id}/submit")
async def submit_count(count_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_manager)):
    stock_count = await submit_stock_count(db, count_id)
    return _stock_count_to_dict(stock_count)


@router.post("/counts/{count_id}/approve")
async def approve_count(count_id: int, db: AsyncSession = Depends(get_db), user=Depends(require_manager)):
    stock_count = await approve_stock_count(db, count_id, user.id)
    return _stock_count_to_dict(stock_count)
