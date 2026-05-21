from sqlalchemy import inspect
from database import sync_engine

def check_schema():
    inspector = inspect(sync_engine)
    
    tables = inspector.get_table_names()
    print(f"Tables: {tables}")
    
    if "system_settings" in tables:
        print("[OK] system_settings table exists")
    else:
        print("[MISSING] system_settings table")
        
    columns = {col['name'] for col in inspector.get_columns("sessions")}
    print(f"Sessions columns: {columns}")
    for col in ["last_activity_at", "invoices_count", "total_sales"]:
        if col in columns:
            print(f"[OK] sessions.{col} exists")
        else:
            print(f"[MISSING] sessions.{col}")

    columns_inv = {col['name'] for col in inspector.get_columns("invoices")}
    if "offline_uuid" in columns_inv:
        print("[OK] invoices.offline_uuid exists")
    else:
        print("[MISSING] invoices.offline_uuid")

if __name__ == "__main__":
    check_schema()
