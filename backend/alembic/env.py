"""
Alembic env.py
يقرأ DATABASE_URL من البيئة تلقائياً — يعمل مع SQLite و PostgreSQL
"""
import os
import sys
from logging.config import fileConfig
from sqlalchemy import engine_from_config, pool
from alembic import context

# أضف مسار المشروع لـ Python path
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# استيراد الـ Base والـ models لاكتشاف الجداول
from database import Base, SYNC_DATABASE_URL
import models  # noqa: F401 — يجب استيراده لتسجيل الجداول في Base.metadata

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# هذا هو مصدر الحقيقة للـ schema
target_metadata = Base.metadata

# استخدم DATABASE_URL من البيئة إذا متوفر، وإلا من alembic.ini
_db_url = SYNC_DATABASE_URL or config.get_main_option("sqlalchemy.url")
config.set_main_option("sqlalchemy.url", _db_url)


def run_migrations_offline() -> None:
    """تشغيل migrations بدون اتصال فعلي (يولّد SQL فقط)"""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """تشغيل migrations مع اتصال فعلي"""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
