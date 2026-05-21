"""initial schema + VAT fields on invoices

Revision ID: 001
Revises:
Create Date: 2025-01-01 00:00:00
"""
from typing import Union
from alembic import op
import sqlalchemy as sa

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels = None
depends_on    = None


def upgrade() -> None:
    # ── إضافة حقول VAT للفواتير (إذا لم تكن موجودة) ─────────────────────────
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = [c["name"] for c in inspector.get_columns("invoices")]

    if "tax_rate" not in existing_cols:
        op.add_column("invoices", sa.Column("tax_rate",   sa.Numeric(5, 2),  nullable=True, server_default="0"))
    if "tax_amount" not in existing_cols:
        op.add_column("invoices", sa.Column("tax_amount", sa.Numeric(10, 2), nullable=True, server_default="0"))

    # ── إضافة indexes إن لم تكن موجودة ───────────────────────────────────────
    existing_indexes = {idx["name"] for idx in inspector.get_indexes("invoices")}
    if "idx_invoices_created_at" not in existing_indexes:
        op.create_index("idx_invoices_created_at",   "invoices", ["created_at"])
    if "idx_invoices_cashier_id" not in existing_indexes:
        op.create_index("idx_invoices_cashier_id",   "invoices", ["cashier_id"])
    if "idx_invoices_is_cancelled" not in existing_indexes:
        op.create_index("idx_invoices_is_cancelled", "invoices", ["is_cancelled"])
    if "idx_invoices_is_paid" not in existing_indexes:
        op.create_index("idx_invoices_is_paid",      "invoices", ["is_paid"])

    prod_indexes = {idx["name"] for idx in inspector.get_indexes("products")}
    if "idx_products_barcode" not in prod_indexes:
        op.create_index("idx_products_barcode",   "products", ["barcode"])
    if "idx_products_is_active" not in prod_indexes:
        op.create_index("idx_products_is_active", "products", ["is_active"])

    # product_barcodes
    try:
        pb_indexes = {idx["name"] for idx in inspector.get_indexes("product_barcodes")}
        if "idx_product_barcodes_barcode" not in pb_indexes:
            op.create_index("idx_product_barcodes_barcode", "product_barcodes", ["barcode"])
    except Exception:
        pass

    # invoice_items
    ii_indexes = {idx["name"] for idx in inspector.get_indexes("invoice_items")}
    if "idx_invoice_items_invoice_id" not in ii_indexes:
        op.create_index("idx_invoice_items_invoice_id", "invoice_items", ["invoice_id"])
    if "idx_invoice_items_product_id" not in ii_indexes:
        op.create_index("idx_invoice_items_product_id", "invoice_items", ["product_id"])

    # sessions
    sess_indexes = {idx["name"] for idx in inspector.get_indexes("sessions")}
    if "idx_sessions_token" not in sess_indexes:
        op.create_index("idx_sessions_token",   "sessions", ["session_token"])
    if "idx_sessions_user_id" not in sess_indexes:
        op.create_index("idx_sessions_user_id", "sessions", ["user_id"])


def downgrade() -> None:
    op.drop_column("invoices", "tax_amount")
    op.drop_column("invoices", "tax_rate")
    for idx in [
        "idx_invoices_created_at", "idx_invoices_cashier_id",
        "idx_invoices_is_cancelled", "idx_invoices_is_paid",
        "idx_products_barcode", "idx_products_is_active",
        "idx_product_barcodes_barcode",
        "idx_invoice_items_invoice_id", "idx_invoice_items_product_id",
        "idx_sessions_token", "idx_sessions_user_id",
    ]:
        try:
            op.drop_index(idx)
        except Exception:
            pass
