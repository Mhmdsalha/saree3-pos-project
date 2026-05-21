import pytest

from models import Product


async def _create_product(db, barcode="6281234567888", stock=10):
    product = Product(name="منتج جرد", barcode=barcode, price=8, stock=stock, is_active=True, min_stock=5)
    db.add(product)
    await db.commit()
    await db.refresh(product)
    return product


@pytest.mark.asyncio
async def test_stock_count_approve_creates_adjustment(client, db, admin_token):
    product = await _create_product(db, stock=10)
    headers = {"Authorization": f"Bearer {admin_token}"}
    create_resp = await client.post(
        "/inventory/counts",
        json={
            "count_type": "daily",
            "count_date": "2026-03-26T00:00:00",
            "items": [{"product_id": product.id, "counted_quantity": 8}],
        },
        headers=headers,
    )
    assert create_resp.status_code == 200, create_resp.text
    count_id = create_resp.json()["id"]

    submit_resp = await client.post(f"/inventory/counts/{count_id}/submit", headers=headers)
    assert submit_resp.status_code == 200, submit_resp.text

    approve_resp = await client.post(f"/inventory/counts/{count_id}/approve", headers=headers)
    assert approve_resp.status_code == 200, approve_resp.text

    await db.refresh(product)
    assert int(product.stock) == 8


@pytest.mark.asyncio
async def test_stock_count_approval_rebases_stale_system_quantity(client, db, admin_token):
    product = await _create_product(db, barcode="6281234567889", stock=10)
    headers = {"Authorization": f"Bearer {admin_token}"}
    create_resp = await client.post(
        "/inventory/counts",
        json={
            "count_type": "daily",
            "count_date": "2026-03-26T00:00:00",
            "items": [{"product_id": product.id, "counted_quantity": 8}],
        },
        headers=headers,
    )
    assert create_resp.status_code == 200, create_resp.text
    count_id = create_resp.json()["id"]

    product.stock = 9
    await db.commit()

    submit_resp = await client.post(f"/inventory/counts/{count_id}/submit", headers=headers)
    assert submit_resp.status_code == 200, submit_resp.text

    approve_resp = await client.post(f"/inventory/counts/{count_id}/approve", headers=headers)
    assert approve_resp.status_code == 200, approve_resp.text

    await db.refresh(product)
    assert int(product.stock) == 8
    item = approve_resp.json()["items"][0]
    assert float(item["system_quantity"]) == 9.0
    assert float(item["difference_quantity"]) == -1.0
