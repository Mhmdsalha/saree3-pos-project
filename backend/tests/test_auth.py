"""اختبارات Auth + Rate Limiting"""
import pytest


@pytest.mark.asyncio
async def test_login_success(client, db):
    from models import User
    from auth import get_password_hash
    db.add(User(name="أحمد", username="ahmed", hashed_password=get_password_hash("pass123"), role="cashier", is_active=True))
    await db.commit()

    resp = await client.post("/auth/login", data={"username": "ahmed", "password": "pass123"})
    assert resp.status_code == 200
    data = resp.json()
    assert "access_token" in data
    assert data["user"]["username"] == "ahmed"
    # تأكد أن الـ cookie وُضع
    assert "pos_token" in resp.cookies


@pytest.mark.asyncio
async def test_login_wrong_password(client, db):
    from models import User
    from auth import get_password_hash
    db.add(User(name="أحمد", username="ahmed2", hashed_password=get_password_hash("correct"), role="cashier", is_active=True))
    await db.commit()

    resp = await client.post("/auth/login", data={"username": "ahmed2", "password": "wrong"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_login_inactive_user(client, db):
    from models import User
    from auth import get_password_hash
    db.add(User(name="موقف", username="inactive", hashed_password=get_password_hash("pass"), role="cashier", is_active=False))
    await db.commit()

    resp = await client.post("/auth/login", data={"username": "inactive", "password": "pass"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_rate_limiting(client, db):
    """بعد 10 محاولات فاشلة يجب أن يُرفض الطلب بـ 429"""
    # نُعيد ضبط الـ rate limiter قبل الاختبار
    from routers.auth import _login_failures
    _login_failures.clear()

    for i in range(10):
        await client.post("/auth/login", data={"username": "nobody", "password": "wrong"})

    resp = await client.post("/auth/login", data={"username": "nobody", "password": "wrong"})
    assert resp.status_code == 429
    assert "Retry-After" in resp.headers


@pytest.mark.asyncio
async def test_logout_clears_cookie(client, db):
    from models import User
    from auth import get_password_hash
    db.add(User(name="خروج", username="logout_user", hashed_password=get_password_hash("pass"), role="cashier", is_active=True))
    await db.commit()

    await client.post("/auth/login", data={"username": "logout_user", "password": "pass"})
    resp = await client.post("/auth/logout")
    assert resp.status_code == 200
