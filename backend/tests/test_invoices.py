"""اختبارات create_invoice — أهم منطق في النظام"""
import pytest
from decimal import Decimal


async def _create_product(db, name="منتج", price=10.0, stock=100, barcode="6281234567890"):
    from models import Product
    p = Product(name=name, barcode=barcode, price=price, stock=stock, is_active=True, min_stock=5)
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return p


async def _open_session(client, token):
    resp = await client.post("/sessions/open", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    return resp.json()["session_token"]


@pytest.mark.asyncio
async def test_create_invoice_basic(client, db, cashier_token):
    p = await _create_product(db)

    resp = await client.post("/invoices", json={
        "items": [{"product_id": p.id, "quantity": 2, "price": float(p.price)}],
        "payment_method": "cash",
        "discount": 0,
        "is_paid": True,
    }, headers={"Authorization": f"Bearer {cashier_token}"})

    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 20.0
    assert data["final_total"] == 20.0
    assert data["is_paid"] is True


@pytest.mark.asyncio
async def test_create_invoice_uses_db_price(client, db, cashier_token):
    """يجب استخدام سعر DB لا سعر الفرونت"""
    p = await _create_product(db, price=10.0)

    resp = await client.post("/invoices", json={
        "items": [{"product_id": p.id, "quantity": 1, "price": 0.01}],  # محاولة تلاعب
        "payment_method": "cash",
        "discount": 0,
        "is_paid": True,
    }, headers={"Authorization": f"Bearer {cashier_token}"})

    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 10.0  # السعر الحقيقي من DB


@pytest.mark.asyncio
async def test_create_invoice_deducts_stock(client, db, cashier_token):
    """يجب حسم المخزون بعد البيع"""
    from sqlalchemy import select
    from models import Product

    p = await _create_product(db, stock=10)
    initial_stock = p.stock

    await client.post("/invoices", json={
        "items": [{"product_id": p.id, "quantity": 3, "price": float(p.price)}],
        "payment_method": "cash", "discount": 0, "is_paid": True,
    }, headers={"Authorization": f"Bearer {cashier_token}"})

    await db.refresh(p)
    assert int(p.stock) == initial_stock - 3


@pytest.mark.asyncio
async def test_create_invoice_insufficient_stock(client, db, cashier_token):
    """يجب رفض الفاتورة إذا المخزون لا يكفي"""
    p = await _create_product(db, stock=2)

    resp = await client.post("/invoices", json={
        "items": [{"product_id": p.id, "quantity": 5, "price": float(p.price)}],
        "payment_method": "cash", "discount": 0, "is_paid": True,
    }, headers={"Authorization": f"Bearer {cashier_token}"})

    assert resp.status_code == 400
    assert "غير كافٍ" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_invoice_rejects_duplicate_lines_over_total_stock(client, db, cashier_token):
    p = await _create_product(db, stock=3)

    resp = await client.post("/invoices", json={
        "items": [
            {"product_id": p.id, "quantity": 2, "price": float(p.price)},
            {"product_id": p.id, "quantity": 2, "price": float(p.price)},
        ],
        "payment_method": "cash", "discount": 0, "is_paid": True,
    }, headers={"Authorization": f"Bearer {cashier_token}"})

    assert resp.status_code == 400
    await db.refresh(p)
    assert float(p.stock) == 3.0


@pytest.mark.asyncio
async def test_create_invoice_rejects_invalid_discount_and_payment_method(client, db, cashier_token):
    p = await _create_product(db, stock=3)
    product_id = p.id
    product_price = float(p.price)
    headers = {"Authorization": f"Bearer {cashier_token}"}

    negative_discount = await client.post("/invoices", json={
        "items": [{"product_id": product_id, "quantity": 1, "price": product_price}],
        "payment_method": "cash", "discount": -1, "is_paid": True,
    }, headers=headers)
    assert negative_discount.status_code == 400

    oversized_discount = await client.post("/invoices", json={
        "items": [{"product_id": product_id, "quantity": 1, "price": product_price}],
        "payment_method": "cash", "discount": 999, "is_paid": True,
    }, headers=headers)
    assert oversized_discount.status_code == 400

    invalid_payment = await client.post("/invoices", json={
        "items": [{"product_id": product_id, "quantity": 1, "price": product_price}],
        "payment_method": "crypto", "discount": 0, "is_paid": True,
    }, headers=headers)
    assert invalid_payment.status_code == 400


@pytest.mark.asyncio
async def test_create_invoice_saves_is_paid(client, db, cashier_token):
    """يجب حفظ is_paid=False للفواتير الآجلة"""
    p = await _create_product(db)

    resp = await client.post("/invoices", json={
        "items": [{"product_id": p.id, "quantity": 1, "price": float(p.price)}],
        "payment_method": "cash", "discount": 0, "is_paid": False,
    }, headers={"Authorization": f"Bearer {cashier_token}"})

    assert resp.status_code == 200
    assert resp.json()["is_paid"] is False


@pytest.mark.asyncio
async def test_create_invoice_with_discount(client, db, cashier_token):
    p = await _create_product(db, price=100.0)

    resp = await client.post("/invoices", json={
        "items": [{"product_id": p.id, "quantity": 1, "price": float(p.price)}],
        "payment_method": "cash", "discount": 10, "is_paid": True,
    }, headers={"Authorization": f"Bearer {cashier_token}"})

    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 100.0
    assert data["discount"] == 10.0
    assert data["final_total"] == 90.0


@pytest.mark.asyncio
async def test_create_invoice_nonexistent_product(client, db, cashier_token):
    resp = await client.post("/invoices", json={
        "items": [{"product_id": 9999, "quantity": 1, "price": 10}],
        "payment_method": "cash", "discount": 0, "is_paid": True,
    }, headers={"Authorization": f"Bearer {cashier_token}"})

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_stock_not_deducted_on_failed_invoice(client, db, cashier_token):
    """لو فشلت الفاتورة، المخزون لا يتأثر (transaction rollback)"""
    from sqlalchemy import select
    from models import Product

    p1 = await _create_product(db, barcode="6281234567890", stock=10)
    p2 = await _create_product(db, barcode="6281234567891", stock=1, name="منتج2")

    initial_stock_p1 = int(p1.stock)

    # p2 مخزونه 1، نطلب 5 — يجب أن تفشل الفاتورة كلها
    resp = await client.post("/invoices", json={
        "items": [
            {"product_id": p1.id, "quantity": 2, "price": float(p1.price)},
            {"product_id": p2.id, "quantity": 5, "price": float(p2.price)},
        ],
        "payment_method": "cash", "discount": 0, "is_paid": True,
    }, headers={"Authorization": f"Bearer {cashier_token}"})

    assert resp.status_code == 400
    # مخزون p1 يجب أن يبقى كما هو
    await db.refresh(p1)
    assert int(p1.stock) == initial_stock_p1


@pytest.mark.asyncio
async def test_create_invoice_with_offline_uuid_is_idempotent(client, db, cashier_token):
    p = await _create_product(db, stock=10, barcode="6281234567990")

    payload = {
        "items": [{"product_id": p.id, "quantity": 2, "price": float(p.price)}],
        "payment_method": "cash",
        "discount": 0,
        "is_paid": True,
        "offline_uuid": "offline-test-uuid-1",
    }

    first = await client.post("/invoices", json=payload, headers={"Authorization": f"Bearer {cashier_token}"})
    assert first.status_code == 200, first.text

    second = await client.post("/invoices", json=payload, headers={"Authorization": f"Bearer {cashier_token}"})
    assert second.status_code == 200, second.text

    first_data = first.json()
    second_data = second.json()
    assert first_data["id"] == second_data["id"]

    await db.refresh(p)
    assert float(p.stock) == 8.0


@pytest.mark.asyncio
async def test_sync_offline_invoices_mixes_success_and_error_results(client, db, cashier_token):
    p_ok = await _create_product(db, name="مقبول", stock=10, barcode="6281234567991")
    p_fail = await _create_product(db, name="مرفوض", stock=1, barcode="6281234567992")

    resp = await client.post(
        "/invoices/sync",
        json=[
            {
                "items": [{"product_id": p_ok.id, "quantity": 3, "price": float(p_ok.price)}],
                "payment_method": "cash",
                "discount": 0,
                "is_paid": True,
                "offline_uuid": "sync-success-1",
            },
            {
                "items": [{"product_id": p_fail.id, "quantity": 5, "price": float(p_fail.price)}],
                "payment_method": "cash",
                "discount": 0,
                "is_paid": True,
                "offline_uuid": "sync-fail-1",
            },
        ],
        headers={"Authorization": f"Bearer {cashier_token}"},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 2
    success = next(item for item in body if item["offline_uuid"] == "sync-success-1")
    failure = next(item for item in body if item["offline_uuid"] == "sync-fail-1")

    assert success["status"] == "ok"
    assert isinstance(success["id"], int)
    assert failure["status"] == "error"
    assert "غير كاف" in failure["detail"]

    await db.refresh(p_ok)
    await db.refresh(p_fail)
    assert float(p_ok.stock) == 7.0
    assert float(p_fail.stock) == 1.0


@pytest.mark.asyncio
async def test_sync_offline_invoices_does_not_duplicate_existing_invoice(client, db, cashier_token):
    p = await _create_product(db, stock=10, barcode="6281234567993")
    payload = {
        "items": [{"product_id": p.id, "quantity": 2, "price": float(p.price)}],
        "payment_method": "cash",
        "discount": 0,
        "is_paid": True,
        "offline_uuid": "sync-deduplicate-1",
    }

    first = await client.post("/invoices/sync", json=[payload], headers={"Authorization": f"Bearer {cashier_token}"})
    second = await client.post("/invoices/sync", json=[payload], headers={"Authorization": f"Bearer {cashier_token}"})

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text

    first_result = first.json()[0]
    second_result = second.json()[0]
    assert first_result["status"] == "ok"
    assert second_result["status"] == "ok"
    assert first_result["id"] == second_result["id"]

    await db.refresh(p)
    assert float(p.stock) == 8.0
