"""
سكريبت migration — شغّله مرة واحدة لتحديث قاعدة البيانات
python migrate.py
"""
import sqlite3, os

DB_PATH = os.getenv("DB_PATH", "./supermarket.db")

def run():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # 1. is_paid في الفواتير
    try:
        cur.execute("ALTER TABLE invoices ADD COLUMN is_paid BOOLEAN DEFAULT 1")
        print("✅ is_paid أضيف للفواتير")
    except sqlite3.OperationalError:
        print("ℹ️  is_paid موجود مسبقاً")

    # 2. جدول الباركودات الإضافية
    cur.execute("""
        CREATE TABLE IF NOT EXISTS product_barcodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            barcode VARCHAR(100) UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    print("✅ جدول product_barcodes جاهز")

    # 3. ── FIX: Indexes للأعمدة الأكثر استخداماً ──────────────────────────────
    indexes = [
        ("idx_products_barcode",         "CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)"),
        ("idx_products_is_active",        "CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active)"),
        ("idx_invoices_created_at",       "CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at)"),
        ("idx_invoices_cashier_id",       "CREATE INDEX IF NOT EXISTS idx_invoices_cashier_id ON invoices(cashier_id)"),
        ("idx_invoices_is_cancelled",     "CREATE INDEX IF NOT EXISTS idx_invoices_is_cancelled ON invoices(is_cancelled)"),
        ("idx_invoice_items_invoice_id",  "CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id)"),
        ("idx_invoice_items_product_id",  "CREATE INDEX IF NOT EXISTS idx_invoice_items_product_id ON invoice_items(product_id)"),
        ("idx_product_barcodes_barcode",  "CREATE INDEX IF NOT EXISTS idx_product_barcodes_barcode ON product_barcodes(barcode)"),
        ("idx_sessions_token",            "CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token)"),
    ]
    for name, sql in indexes:
        cur.execute(sql)
        print(f"✅ index {name}")

    conn.commit()
    conn.close()
    print("\n✅ Migration مكتمل")

if __name__ == "__main__":
    run()