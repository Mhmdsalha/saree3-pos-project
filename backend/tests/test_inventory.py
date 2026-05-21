import pytest
from sqlalchemy import select

from models import Product, StockMovement, Supplier


async def _create_product(db, *, name, barcode, stock, buy_price=5.0, price=10.0, min_stock=5):
    product = Product(
        name=name,
        barcode=barcode,
        stock=stock,
        buy_price=buy_price,
        price=price,
        min_stock=min_stock,
        is_active=True,
    )
    db.add(product)
    await db.commit()
    await db.refresh(product)
    return product


@pytest.mark.asyncio
async def test_inventory_overview_returns_summary(client, db, admin_token):
    await _create_product(db, name="منخفض", barcode="6281234567801", stock=2, min_stock=5)
    await _create_product(db, name="نافد", barcode="6281234567802", stock=0, min_stock=5)

    resp = await client.get("/inventory/overview", headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["summary"]["out_of_stock"] >= 1
    assert data["summary"]["low_stock_count"] >= 1


@pytest.mark.asyncio
async def test_inventory_movements_include_sales(client, db, cashier_token):
    product = await _create_product(db, name="منتج بيع", barcode="6281234567803", stock=10)
    await client.post(
        "/invoices",
        json={
            "items": [{"product_id": product.id, "quantity": 2, "price": 10}],
            "payment_method": "cash",
            "discount": 0,
            "is_paid": True,
        },
        headers={"Authorization": f"Bearer {cashier_token}"},
    )

    resp = await client.get("/inventory/movements", headers={"Authorization": f"Bearer {cashier_token}"})
    assert resp.status_code == 403
