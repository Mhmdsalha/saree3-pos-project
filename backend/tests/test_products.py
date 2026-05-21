"""اختبارات المنتجات والباركود."""
import pytest
from sqlalchemy import select

from models import Category, Product, StoreProfile
from services.launcher_service import ensure_store_categories, get_category_suggestions

VALID_EAN13 = "6281234567888"


@pytest.mark.asyncio
async def test_create_product(client, db, admin_token):
    resp = await client.post(
        "/products",
        json={
            "barcode": VALID_EAN13,
            "name": "عصير برتقال",
            "price": 5.50,
            "buy_price": 3.0,
            "stock": 50,
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["barcode"] == VALID_EAN13
    assert data["price"] == 5.5


@pytest.mark.asyncio
async def test_create_product_invalid_price(client, db, admin_token):
    resp = await client.post(
        "/products",
        json={"barcode": VALID_EAN13, "name": "منتج", "price": 0, "stock": 10},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_product_invalid_barcode(client, db, admin_token):
    resp = await client.post(
        "/products",
        json={"barcode": "12345", "name": "منتج", "price": 5.0, "stock": 10},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_duplicate_barcode_rejected(client, db, admin_token):
    for _ in range(2):
        resp = await client.post(
            "/products",
            json={"barcode": VALID_EAN13, "name": "منتج", "price": 5.0, "stock": 10},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_cashier_cannot_create_product(client, db, cashier_token):
    resp = await client.post(
        "/products",
        json={"barcode": VALID_EAN13, "name": "منتج", "price": 5.0, "stock": 10},
        headers={"Authorization": f"Bearer {cashier_token}"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_soft_delete_product(client, db, admin_token):
    create = await client.post(
        "/products",
        json={"barcode": VALID_EAN13, "name": "منتج", "price": 5.0, "stock": 0},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    pid = create.json()["id"]

    await client.delete(f"/products/{pid}", headers={"Authorization": f"Bearer {admin_token}"})

    product = (await db.execute(select(Product).where(Product.id == pid))).scalar_one_or_none()
    assert product is not None
    assert product.is_active is False


@pytest.mark.asyncio
async def test_deleted_product_not_scannable(client, db, admin_token, cashier_token):
    create = await client.post(
        "/products",
        json={"barcode": VALID_EAN13, "name": "منتج", "price": 5.0, "stock": 0},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    pid = create.json()["id"]

    await client.delete(f"/products/{pid}", headers={"Authorization": f"Bearer {admin_token}"})

    resp = await client.get(f"/products/barcode/{VALID_EAN13}", headers={"Authorization": f"Bearer {cashier_token}"})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_store_type_categories_are_seeded_without_removing_existing(db):
    db.add(
        StoreProfile(
            store_id="flowpos-test",
            store_name="Pharmacy Store",
            country="Palestine",
            currency="ILS",
            store_type="pharmacy",
        )
    )
    db.add(Category(name="Manual Category"))
    await db.commit()

    await ensure_store_categories(db)

    names = set((await db.execute(select(Category.name))).scalars().all())
    assert "Manual Category" in names
    for suggested_name in get_category_suggestions("pharmacy"):
        assert suggested_name in names


@pytest.mark.asyncio
async def test_public_storefront_exposes_logo_url_and_serves_logo_file(client, db, tmp_path):
    logo_path = tmp_path / "store-logo.png"
    logo_path.write_bytes(b"\x89PNG\r\n\x1a\n")
    db.add(
        StoreProfile(
            store_id="flowpos-branding-test",
            store_name="FlowPOS Pharmacy",
            country="Palestine",
            currency="ILS",
            store_type="pharmacy",
            logo_path=str(logo_path),
        )
    )
    await db.commit()

    storefront_response = await client.get("/launcher/public-storefront")
    assert storefront_response.status_code == 200
    storefront_payload = storefront_response.json()
    assert storefront_payload["logo_url"].startswith("/launcher/store-logo?v=")

    logo_response = await client.get("/launcher/store-logo")
    assert logo_response.status_code == 200
    assert logo_response.headers["content-type"].startswith("image/png")


@pytest.mark.asyncio
async def test_printable_barcode_returns_primary_barcode(client, db, admin_token):
    create = await client.post(
        "/products",
        json={
            "barcode": VALID_EAN13,
            "name": "مشروب غازي",
            "price": 6.0,
            "buy_price": 3.5,
            "stock": 20,
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert create.status_code == 200, create.text
    product_id = create.json()["id"]

    response = await client.post(
        f"/products/{product_id}/printable-barcode",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["barcode"] == VALID_EAN13
    assert payload["source"] == "primary"


@pytest.mark.asyncio
async def test_printable_barcode_rejects_products_without_primary_barcode(client, db, admin_token):
    create = await client.post(
        "/products",
        json={
            "name": "صنف بدون باركود",
            "price": 8.0,
            "buy_price": 4.0,
            "stock": 12,
            "sell_without_barcode": True,
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert create.status_code == 200, create.text
    product_id = create.json()["id"]

    response = await client.post(
        f"/products/{product_id}/printable-barcode",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert response.status_code == 400
    assert "باركودًا أساسيًا" in response.text


@pytest.mark.asyncio
async def test_printable_barcode_rejects_weighted_product(client, db, admin_token):
    db.add(
        StoreProfile(
            store_id="flowpos-supermarket",
            store_name="Supermarket Store",
            country="Palestine",
            currency="ILS",
            store_type="supermarket",
        )
    )
    await db.commit()

    create = await client.post(
        "/products",
        json={
            "name": "تفاح موزون",
            "price": 12.0,
            "buy_price": 7.0,
            "stock": 10,
            "is_weighted": True,
            "unit": "كغ",
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert create.status_code == 200, create.text
    product_id = create.json()["id"]

    response = await client.post(
        f"/products/{product_id}/printable-barcode",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert response.status_code == 400
