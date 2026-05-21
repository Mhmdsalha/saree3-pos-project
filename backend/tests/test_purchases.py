import pytest
from sqlalchemy import select

from models import Product, StockMovement, Supplier


async def _create_supplier(db, name="مورد الاختبار"):
    supplier = Supplier(name=name, is_active=True)
    db.add(supplier)
    await db.commit()
    await db.refresh(supplier)
    return supplier


async def _create_product(db, *, name="منتج", barcode="6281234567890", price=10.0, stock=0, track_expiry=False, track_batch=False):
    product = Product(
        name=name,
        barcode=barcode,
        price=price,
        stock=stock,
        is_active=True,
        min_stock=5,
        track_expiry=track_expiry,
        track_batch=track_batch,
    )
    db.add(product)
    await db.commit()
    await db.refresh(product)
    return product


@pytest.mark.asyncio
async def test_confirm_purchase_increases_stock_and_creates_movement(client, db, admin_token):
    supplier = await _create_supplier(db)
    product = await _create_product(db)

    headers = {"Authorization": f"Bearer {admin_token}"}
    create_resp = await client.post(
        "/purchases",
        json={
            "supplier_id": supplier.id,
            "invoice_number": "PO-1001",
            "purchase_date": "2026-03-26T10:00:00",
            "discount_amount": 0,
            "items": [
                {
                    "product_id": product.id,
                    "quantity": 12,
                    "purchase_price": 5.5,
                    "selling_price": 9.5,
                }
            ],
        },
        headers=headers,
    )
    assert create_resp.status_code == 200, create_resp.text
    purchase_id = create_resp.json()["id"]

    confirm_resp = await client.post(f"/purchases/{purchase_id}/confirm", headers=headers)
    assert confirm_resp.status_code == 200, confirm_resp.text
    assert confirm_resp.json()["status"] == "confirmed"

    await db.refresh(product)
    assert int(product.stock) == 12

    movement = (await db.execute(select(StockMovement).where(StockMovement.product_id == product.id))).scalar_one_or_none()
    assert movement is not None
    assert movement.movement_type == "purchase"


@pytest.mark.asyncio
async def test_track_expiry_purchase_requires_expiry(client, db, admin_token):
    supplier = await _create_supplier(db, "مورد الانتهاء")
    product = await _create_product(db, barcode="6281234567891", track_expiry=True)

    resp = await client.post(
        "/purchases",
        json={
            "supplier_id": supplier.id,
            "invoice_number": "PO-1002",
            "purchase_date": "2026-03-26T10:00:00",
            "discount_amount": 0,
            "items": [{"product_id": product.id, "quantity": 3, "purchase_price": 4}],
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 422
