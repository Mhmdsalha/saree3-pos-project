"""
إعداد pytest — قاعدة بيانات SQLite في الذاكرة لكل اختبار
"""
import os
# يجب أن يكون قبل أي import من المشروع
os.environ.setdefault("DATABASE_URL", "sqlite:///./supermarket.db")

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

# ── Engine للاختبار — SQLite في الذاكرة ───────────────────────────────────────
_TEST_DB_URL = "sqlite+aiosqlite:///:memory:"

TEST_ENGINE = create_async_engine(_TEST_DB_URL, echo=False)
TestSession  = sessionmaker(TEST_ENGINE, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(autouse=True)
def reset_login_rate_limit_state():
    from routers import auth as auth_router

    auth_router._login_failures.clear()
    yield
    auth_router._login_failures.clear()


@pytest.fixture(autouse=True)
def isolate_license_state(tmp_path, monkeypatch):
    from services.license_local_protection_service import clear_protected_license_state
    from services.timezone_service import clear_trusted_time_cache

    config_dir = tmp_path / ".flowpos-config"
    config_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("FLOWPOS_CONFIG_DIR", str(config_dir))
    monkeypatch.setenv("FLOWPOS_TRUSTED_TIME_ENABLED", "0")
    clear_protected_license_state(config_dir)
    clear_trusted_time_cache()
    yield
    clear_protected_license_state(config_dir)
    clear_trusted_time_cache()


@pytest_asyncio.fixture(scope="function")
async def db():
    """قاعدة بيانات نظيفة لكل اختبار"""
    # import هنا لضمان أن Base مكتمل
    from database import Base
    import models  # noqa — يجب تحميله لتسجيل الجداول

    async with TEST_ENGINE.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with TestSession() as session:
        yield session

    async with TEST_ENGINE.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture(scope="function")
async def client(db):
    """HTTP client مع override للـ DB"""
    from database import get_db

    # import app هنا لتجنب circular imports
    import sys, importlib
    if "main_new" in sys.modules:
        app_module = sys.modules["main_new"]
    else:
        import importlib.util, pathlib
        # ابحث عن main_new.py أو main.py
        backend_dir = pathlib.Path(__file__).parent.parent
        for name in ("main_new", "main"):
            path = backend_dir / f"{name}.py"
            if path.exists():
                spec = importlib.util.spec_from_file_location(name, path)
                app_module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(app_module)
                break

    app = app_module.app

    async def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test"
    ) as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest_asyncio.fixture(scope="function")
async def admin_token(client, db):
    from models import User
    from auth import get_password_hash

    admin = User(
        name="مدير الاختبار",
        username="test_admin",
        hashed_password=get_password_hash("admin123"),
        role="admin",
        cashier_number=0,
        is_active=True,
    )
    db.add(admin)
    await db.commit()

    resp = await client.post("/auth/login", data={"username": "test_admin", "password": "admin123"})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


@pytest_asyncio.fixture(scope="function")
async def cashier_token(client, db):
    from models import User
    from auth import get_password_hash

    cashier = User(
        name="كاشير الاختبار",
        username="test_cashier",
        hashed_password=get_password_hash("cashier123"),
        role="cashier",
        cashier_number=1,
        is_active=True,
    )
    db.add(cashier)
    await db.commit()

    resp = await client.post("/auth/login", data={"username": "test_cashier", "password": "cashier123"})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]
