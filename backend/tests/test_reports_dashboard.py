from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from models import Invoice, InvoiceItem, InvoiceReturn, InvoiceReturnItem, Product, User


VALID_EAN13_A = "6281234567895"
VALID_EAN13_B = "6281234567871"


@pytest.mark.asyncio
async def test_reports_dashboard_uses_actual_return_period(client, db, admin_token):
    admin_user = (await db.execute(select(User).where(User.username == "test_admin"))).scalar_one()
    now = datetime(2026, 5, 10, 12, 0, 0, tzinfo=UTC).replace(tzinfo=None)
    yesterday = now - timedelta(days=2)

    product_a = Product(
        name="عصير تفاح",
        barcode=VALID_EAN13_A,
        price=10,
        buy_price=6,
        stock=20,
        is_sellable=True,
        is_active=True,
        unit="قطعة",
    )
    product_b = Product(
        name="بسكويت",
        barcode=VALID_EAN13_B,
        price=5,
        buy_price=2,
        stock=15,
        is_sellable=True,
        is_active=True,
        unit="قطعة",
    )
    db.add_all([product_a, product_b])
    await db.flush()

    invoice_old = Invoice(
        cashier_id=admin_user.id,
        payment_method="cash",
        total=100,
        discount=0,
        final_total=100,
        created_at=yesterday,
        is_paid=True,
        is_cancelled=False,
        returned_amount=20,
    )
    invoice_today = Invoice(
        cashier_id=admin_user.id,
        payment_method="card",
        total=50,
        discount=0,
        final_total=50,
        created_at=now,
        is_paid=True,
        is_cancelled=False,
        returned_amount=0,
    )
    db.add_all([invoice_old, invoice_today])
    await db.flush()

    old_item = InvoiceItem(invoice_id=invoice_old.id, product_id=product_a.id, quantity=10, price=10, subtotal=100)
    today_item = InvoiceItem(invoice_id=invoice_today.id, product_id=product_b.id, quantity=10, price=5, subtotal=50)
    db.add_all([old_item, today_item])
    await db.flush()

    return_ref = InvoiceReturn(
        original_invoice_id=invoice_old.id,
        cashier_id=admin_user.id,
        total_refunded=20,
        refund_method="cash",
        created_at=now,
    )
    db.add(return_ref)
    await db.flush()
    db.add(
        InvoiceReturnItem(
            return_id=return_ref.id,
            invoice_item_id=old_item.id,
            product_id=product_a.id,
            quantity=2,
            price=10,
            subtotal=20,
        )
    )
    await db.commit()

    response = await client.get(
        f"/reports/dashboard?preset=today&date_from={now.date().isoformat()}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()

    assert payload["kpis"]["gross_sales"] == 50.0
    assert payload["kpis"]["total_returns"] == 20.0
    assert payload["kpis"]["net_sales"] == 30.0
    assert payload["kpis"]["invoice_count"] == 1
    assert payload["kpis"]["return_count"] == 1
    assert any(point["returns"] == 20.0 for point in payload["series"]["returns_vs_sales"])


@pytest.mark.asyncio
async def test_reports_dashboard_requires_manager_role(client, cashier_token):
    response = await client.get("/reports/dashboard?preset=today", headers={"Authorization": f"Bearer {cashier_token}"})
    assert response.status_code == 403
