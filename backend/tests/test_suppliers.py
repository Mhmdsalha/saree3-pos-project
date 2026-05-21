import pytest

from auth import get_password_hash
from models import Supplier, User


@pytest.mark.asyncio
async def test_create_supplier(client, admin_token):
    resp = await client.post(
        "/suppliers",
        json={"name": "مورد الخليج", "phone": "0599000000"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["name"] == "مورد الخليج"


@pytest.mark.asyncio
async def test_duplicate_supplier_name_rejected(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    await client.post("/suppliers", json={"name": "مورد موحد"}, headers=headers)
    resp = await client.post("/suppliers", json={"name": "مورد موحد"}, headers=headers)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_cashier_cannot_access_suppliers(client, cashier_token):
    resp = await client.get("/suppliers", headers={"Authorization": f"Bearer {cashier_token}"})
    assert resp.status_code == 403
