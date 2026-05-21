import pytest

from sqlalchemy import select

from models import Product, StockMovement


async def _create_product(db, barcode="6281234567990", price=10.0, stock=20):
    product = Product(name="منتج مرتجع", barcode=barcode, price=price, stock=stock, is_active=True, min_stock=5)
    db.add(product)
    await db.commit()
    await db.refresh(product)
    return product


@pytest.mark.asyncio
async def test_return_cannot_exceed_remaining_quantity(client, db, cashier_token):
    product = await _create_product(db)
    headers = {"Authorization": f"Bearer {cashier_token}"}
    invoice_resp = await client.post(
        "/invoices",
        json={
            "items": [{"product_id": product.id, "quantity": 2, "price": float(product.price)}],
            "payment_method": "cash",
            "discount": 0,
            "is_paid": True,
        },
        headers=headers,
    )
    assert invoice_resp.status_code == 200, invoice_resp.text
    invoice = invoice_resp.json()
    item_id = invoice["items"][0]["id"]

    first_return = await client.post(
        "/returns",
        json={"invoice_id": invoice["id"], "items": [{"invoice_item_id": item_id, "quantity": 1}]},
        headers=headers,
    )
    assert first_return.status_code == 200, first_return.text

    second_return = await client.post(
        "/returns",
        json={"invoice_id": invoice["id"], "items": [{"invoice_item_id": item_id, "quantity": 2}]},
        headers=headers,
    )
    assert second_return.status_code == 400


@pytest.mark.asyncio
async def test_return_combines_duplicate_items_before_remaining_check(client, db, cashier_token):
    product = await _create_product(db, barcode="6281234567991", stock=10)
    headers = {"Authorization": f"Bearer {cashier_token}"}
    invoice_resp = await client.post(
        "/invoices",
        json={
            "items": [{"product_id": product.id, "quantity": 2, "price": float(product.price)}],
            "payment_method": "cash",
            "discount": 0,
            "is_paid": True,
        },
        headers=headers,
    )
    assert invoice_resp.status_code == 200, invoice_resp.text
    invoice = invoice_resp.json()
    item_id = invoice["items"][0]["id"]

    duplicate_return = await client.post(
        "/returns",
        json={
            "invoice_id": invoice["id"],
            "items": [
                {"invoice_item_id": item_id, "quantity": 1.5},
                {"invoice_item_id": item_id, "quantity": 1},
            ],
        },
        headers=headers,
    )
    assert duplicate_return.status_code == 400


@pytest.mark.asyncio
async def test_return_stock_movement_uses_product_cost_not_sale_price(client, db, cashier_token):
    product = await _create_product(db, barcode="6281234567992", price=10.0, stock=10)
    product.buy_price = 4.0
    await db.commit()
    headers = {"Authorization": f"Bearer {cashier_token}"}
    invoice_resp = await client.post(
        "/invoices",
        json={
            "items": [{"product_id": product.id, "quantity": 1, "price": float(product.price)}],
            "payment_method": "cash",
            "discount": 0,
            "is_paid": True,
        },
        headers=headers,
    )
    assert invoice_resp.status_code == 200, invoice_resp.text
    invoice = invoice_resp.json()

    return_resp = await client.post(
        "/returns",
        json={"invoice_id": invoice["id"], "items": [{"invoice_item_id": invoice["items"][0]["id"], "quantity": 1}]},
        headers=headers,
    )
    assert return_resp.status_code == 200, return_resp.text

    movement = (
        await db.execute(
            select(StockMovement).where(
                StockMovement.product_id == product.id,
                StockMovement.movement_type == "sale_return",
            )
        )
    ).scalar_one()
    assert float(movement.unit_cost) == 4.0


@pytest.mark.asyncio
async def test_cashier_cannot_create_return_for_another_cashiers_invoice(client, db, cashier_token):
    from auth import get_password_hash
    from models import User

    product = await _create_product(db, barcode="6281234567993", stock=10)
    owner_headers = {"Authorization": f"Bearer {cashier_token}"}
    invoice_resp = await client.post(
        "/invoices",
        json={
            "items": [{"product_id": product.id, "quantity": 1, "price": float(product.price)}],
            "payment_method": "cash",
            "discount": 0,
            "is_paid": True,
        },
        headers=owner_headers,
    )
    assert invoice_resp.status_code == 200, invoice_resp.text
    invoice = invoice_resp.json()

    other = User(
        name="Other Cashier",
        username="other_return_cashier",
        hashed_password=get_password_hash("cashier-pass"),
        role="cashier",
        is_active=True,
    )
    db.add(other)
    await db.commit()

    login_resp = await client.post("/auth/login", data={"username": "other_return_cashier", "password": "cashier-pass"})
    assert login_resp.status_code == 200, login_resp.text
    other_headers = {"Authorization": f"Bearer {login_resp.json()['access_token']}"}

    return_resp = await client.post(
        "/returns",
        json={"invoice_id": invoice["id"], "items": [{"invoice_item_id": invoice["items"][0]["id"], "quantity": 1}]},
        headers=other_headers,
    )
    assert return_resp.status_code == 403
