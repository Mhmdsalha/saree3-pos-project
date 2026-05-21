#!/usr/bin/env python3
"""
سكريبت نقل البيانات من SQLite إلى PostgreSQL
الاستخدام:
    python migrate_to_postgres.py --sqlite ./supermarket.db --postgres postgresql://user:pass@localhost/flowpos
"""
import argparse
import sys

def migrate(sqlite_url: str, postgres_url: str):
    from sqlalchemy import create_engine, text, inspect

    print("🔄 جارٍ الاتصال بقاعدتَي البيانات...")
    src = create_engine(sqlite_url,   connect_args={"check_same_thread": False})
    dst = create_engine(postgres_url)

    # إنشاء الجداول في PostgreSQL
    print("🏗️  إنشاء الجداول في PostgreSQL...")
    from database import Base, SYNC_DATABASE_URL
    import models  # noqa
    import os
    os.environ["DATABASE_URL"] = postgres_url
    from sqlalchemy.orm import sessionmaker
    Base.metadata.create_all(dst)

    inspector = inspect(src)
    tables = inspector.get_table_names()
    # ترتيب النقل يراعي الـ foreign keys
    ordered = ["users", "categories", "products", "product_barcodes",
               "sessions", "invoices", "invoice_items"]
    tables = [t for t in ordered if t in tables] + [t for t in tables if t not in ordered]

    with src.connect() as src_conn, dst.connect() as dst_conn:
        for table in tables:
            print(f"📋 نقل جدول: {table}")
            rows = src_conn.execute(text(f"SELECT * FROM {table}")).fetchall()
            if not rows:
                print(f"   ← فارغ، تم التخطي")
                continue

            # حذف البيانات القديمة من الوجهة
            dst_conn.execute(text(f"TRUNCATE TABLE {table} RESTART IDENTITY CASCADE"))

            # نقل على دفعات
            cols = inspector.get_columns(table)
            col_names = [c["name"] for c in cols]
            placeholders = ", ".join([f":{c}" for c in col_names])
            col_str = ", ".join(col_names)
            insert_sql = text(f"INSERT INTO {table} ({col_str}) VALUES ({placeholders})")

            batch = []
            for row in rows:
                batch.append(dict(zip(col_names, row)))
                if len(batch) >= 500:
                    dst_conn.execute(insert_sql, batch)
                    batch = []
            if batch:
                dst_conn.execute(insert_sql, batch)

            dst_conn.commit()
            print(f"   ✅ {len(rows)} سطر")

    print("\n✅ اكتمل النقل بنجاح!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="نقل البيانات من SQLite إلى PostgreSQL")
    parser.add_argument("--sqlite",   required=True, help="sqlite:///./supermarket.db")
    parser.add_argument("--postgres", required=True, help="postgresql://user:pass@host/db")
    args = parser.parse_args()

    if not args.sqlite.startswith("sqlite"):
        args.sqlite = f"sqlite:///{args.sqlite}"

    migrate(args.sqlite, args.postgres)
