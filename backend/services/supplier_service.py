from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import Purchase, Supplier


async def ensure_supplier_name_available(
    db: AsyncSession,
    name: str,
    *,
    exclude_id: int | None = None,
):
    stmt = select(Supplier).where(func.lower(Supplier.name) == name.strip().lower(), Supplier.is_active == True)
    if exclude_id:
        stmt = stmt.where(Supplier.id != exclude_id)
    existing = (await db.execute(stmt)).scalar_one_or_none()
    if existing:
        raise ValueError("يوجد مورد نشط بنفس الاسم")


async def ensure_supplier_can_be_deactivated(db: AsyncSession, supplier: Supplier):
    confirmed_purchase = (
        await db.execute(
            select(Purchase.id).where(Purchase.supplier_id == supplier.id, Purchase.status == "confirmed").limit(1)
        )
    ).scalar_one_or_none()
    if confirmed_purchase:
        raise ValueError("لا يمكن تعطيل المورد لارتباطه بمشتريات مؤكدة")
