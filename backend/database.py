"""
database.py — يدعم PostgreSQL و SQLite تلقائياً حسب DATABASE_URL
"""
import os
from pathlib import Path
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from sqlalchemy import create_engine, event

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_SQLITE_PATH = BASE_DIR / "supermarket.db"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DEFAULT_SQLITE_PATH.as_posix()}")

_is_postgres = DATABASE_URL.startswith("postgresql") or DATABASE_URL.startswith("postgres")
_is_sqlite   = DATABASE_URL.startswith("sqlite")

# ── بناء URLs ─────────────────────────────────────────────────────────────────
if _is_postgres:
    ASYNC_DATABASE_URL = DATABASE_URL \
        .replace("postgresql://", "postgresql+asyncpg://") \
        .replace("postgres://",   "postgresql+asyncpg://")
    SYNC_DATABASE_URL = DATABASE_URL \
        .replace("postgresql+asyncpg://", "postgresql://") \
        .replace("postgres://",           "postgresql://")
elif _is_sqlite:
    # sqlite:///./x.db → sqlite+aiosqlite:///./x.db
    ASYNC_DATABASE_URL = DATABASE_URL.replace("sqlite:///", "sqlite+aiosqlite:///")
    SYNC_DATABASE_URL  = DATABASE_URL
else:
    raise ValueError(f"DATABASE_URL غير مدعوم: {DATABASE_URL}")

# ── Async Engine ──────────────────────────────────────────────────────────────
if _is_postgres:
    engine = create_async_engine(
        ASYNC_DATABASE_URL,
        echo=False,
        pool_size=10,
        max_overflow=20,
        pool_pre_ping=True,
        pool_recycle=3600,
    )
else:
    # SQLite async — بدون connect_args (aiosqlite لا يحتاجها)
    engine = create_async_engine(
        ASYNC_DATABASE_URL,
        echo=False,
    )

# ── Sync Engine (للـ Alembic والـ seed) ──────────────────────────────────────
if _is_postgres:
    sync_engine = create_engine(
        SYNC_DATABASE_URL,
        echo=False,
        pool_size=5,
        max_overflow=10,
        pool_pre_ping=True,
    )
else:
    sync_engine = create_engine(
        SYNC_DATABASE_URL,
        echo=False,
        connect_args={"check_same_thread": False},
    )
    # تفعيل Foreign Keys + WAL في SQLite
    @event.listens_for(sync_engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

# ── Sessions ──────────────────────────────────────────────────────────────────
AsyncSessionLocal = sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

SyncSessionLocal = sessionmaker(sync_engine)

if _is_sqlite:
    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_async_pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
