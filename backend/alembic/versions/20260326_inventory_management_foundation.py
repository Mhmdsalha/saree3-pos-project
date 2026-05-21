"""inventory management foundation

Revision ID: 20260326_inventory_management_foundation
Revises: 20260325_attendance_module
Create Date: 2026-03-26
"""
from alembic import op
import sqlalchemy as sa


revision = "20260326_inventory_management_foundation"
down_revision = "20260325_attendance_module"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "suppliers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("phone", sa.String(length=30), nullable=True),
        sa.Column("contact_name", sa.String(length=100), nullable=True),
        sa.Column("address", sa.String(length=255), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index("idx_suppliers_name", "suppliers", ["name"])
    op.create_index("idx_suppliers_is_active", "suppliers", ["is_active"])

    with op.batch_alter_table("products") as batch_op:
        batch_op.add_column(sa.Column("default_supplier_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("track_expiry", sa.Boolean(), nullable=True, server_default=sa.false()))
        batch_op.add_column(sa.Column("track_batch", sa.Boolean(), nullable=True, server_default=sa.false()))
        batch_op.create_foreign_key("fk_products_default_supplier", "suppliers", ["default_supplier_id"], ["id"])
        batch_op.create_index("idx_products_default_supplier", ["default_supplier_id"])

    op.execute("UPDATE products SET track_expiry = CASE WHEN expiry_date IS NOT NULL THEN 1 ELSE 0 END")

    op.create_table(
        "purchases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("supplier_id", sa.Integer(), sa.ForeignKey("suppliers.id"), nullable=False),
        sa.Column("invoice_number", sa.String(length=100), nullable=False),
        sa.Column("purchase_date", sa.DateTime(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="draft"),
        sa.Column("subtotal", sa.Numeric(12, 2), nullable=True),
        sa.Column("discount_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("confirmed_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index("idx_purchases_supplier_id", "purchases", ["supplier_id"])
    op.create_index("idx_purchases_purchase_date", "purchases", ["purchase_date"])
    op.create_index("idx_purchases_status", "purchases", ["status"])
    op.create_index("idx_purchases_invoice_number", "purchases", ["invoice_number"])

    op.create_table(
        "purchase_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("purchase_id", sa.Integer(), sa.ForeignKey("purchases.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("quantity", sa.Numeric(10, 3), nullable=False),
        sa.Column("purchase_price", sa.Numeric(10, 2), nullable=False),
        sa.Column("selling_price", sa.Numeric(10, 2), nullable=True),
        sa.Column("line_total", sa.Numeric(12, 2), nullable=False),
        sa.Column("expiry_date", sa.DateTime(), nullable=True),
        sa.Column("batch_number", sa.String(length=100), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
    )
    op.create_index("idx_purchase_items_purchase_id", "purchase_items", ["purchase_id"])
    op.create_index("idx_purchase_items_product_id", "purchase_items", ["product_id"])

    op.create_table(
        "product_batches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("purchase_item_id", sa.Integer(), sa.ForeignKey("purchase_items.id"), nullable=True),
        sa.Column("supplier_id", sa.Integer(), sa.ForeignKey("suppliers.id"), nullable=True),
        sa.Column("batch_number", sa.String(length=100), nullable=True),
        sa.Column("expiry_date", sa.DateTime(), nullable=True),
        sa.Column("received_quantity", sa.Numeric(10, 3), nullable=False),
        sa.Column("available_quantity", sa.Numeric(10, 3), nullable=False),
        sa.Column("purchase_price", sa.Numeric(10, 2), nullable=False),
        sa.Column("selling_price", sa.Numeric(10, 2), nullable=True),
        sa.Column("received_at", sa.DateTime(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("idx_product_batches_product_id", "product_batches", ["product_id"])
    op.create_index("idx_product_batches_expiry_date", "product_batches", ["expiry_date"])
    op.create_index("idx_product_batches_status", "product_batches", ["status"])

    op.create_table(
        "stock_movements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("batch_id", sa.Integer(), sa.ForeignKey("product_batches.id"), nullable=True),
        sa.Column("movement_type", sa.String(length=30), nullable=False),
        sa.Column("quantity", sa.Numeric(10, 3), nullable=False),
        sa.Column("unit_cost", sa.Numeric(10, 2), nullable=True),
        sa.Column("reference_type", sa.String(length=30), nullable=False),
        sa.Column("reference_id", sa.Integer(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("idx_stock_movements_product_id", "stock_movements", ["product_id"])
    op.create_index("idx_stock_movements_batch_id", "stock_movements", ["batch_id"])
    op.create_index("idx_stock_movements_created_at", "stock_movements", ["created_at"])
    op.create_index("idx_stock_movements_reference", "stock_movements", ["reference_type", "reference_id"])

    op.create_table(
        "stock_counts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("count_type", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="draft"),
        sa.Column("count_date", sa.DateTime(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("approved_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index("idx_stock_counts_count_date", "stock_counts", ["count_date"])
    op.create_index("idx_stock_counts_status", "stock_counts", ["status"])

    op.create_table(
        "stock_count_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("stock_count_id", sa.Integer(), sa.ForeignKey("stock_counts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("batch_id", sa.Integer(), sa.ForeignKey("product_batches.id"), nullable=True),
        sa.Column("system_quantity", sa.Numeric(10, 3), nullable=False),
        sa.Column("counted_quantity", sa.Numeric(10, 3), nullable=False),
        sa.Column("difference_quantity", sa.Numeric(10, 3), nullable=False),
        sa.Column("adjustment_reason", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
    )
    op.create_index("idx_stock_count_items_stock_count_id", "stock_count_items", ["stock_count_id"])
    op.create_index("idx_stock_count_items_product_id", "stock_count_items", ["product_id"])


def downgrade() -> None:
    op.drop_index("idx_stock_count_items_product_id", table_name="stock_count_items")
    op.drop_index("idx_stock_count_items_stock_count_id", table_name="stock_count_items")
    op.drop_table("stock_count_items")

    op.drop_index("idx_stock_counts_status", table_name="stock_counts")
    op.drop_index("idx_stock_counts_count_date", table_name="stock_counts")
    op.drop_table("stock_counts")

    op.drop_index("idx_stock_movements_reference", table_name="stock_movements")
    op.drop_index("idx_stock_movements_created_at", table_name="stock_movements")
    op.drop_index("idx_stock_movements_batch_id", table_name="stock_movements")
    op.drop_index("idx_stock_movements_product_id", table_name="stock_movements")
    op.drop_table("stock_movements")

    op.drop_index("idx_product_batches_status", table_name="product_batches")
    op.drop_index("idx_product_batches_expiry_date", table_name="product_batches")
    op.drop_index("idx_product_batches_product_id", table_name="product_batches")
    op.drop_table("product_batches")

    op.drop_index("idx_purchase_items_product_id", table_name="purchase_items")
    op.drop_index("idx_purchase_items_purchase_id", table_name="purchase_items")
    op.drop_table("purchase_items")

    op.drop_index("idx_purchases_invoice_number", table_name="purchases")
    op.drop_index("idx_purchases_status", table_name="purchases")
    op.drop_index("idx_purchases_purchase_date", table_name="purchases")
    op.drop_index("idx_purchases_supplier_id", table_name="purchases")
    op.drop_table("purchases")

    with op.batch_alter_table("products") as batch_op:
        batch_op.drop_index("idx_products_default_supplier")
        batch_op.drop_constraint("fk_products_default_supplier", type_="foreignkey")
        batch_op.drop_column("track_batch")
        batch_op.drop_column("track_expiry")
        batch_op.drop_column("default_supplier_id")

    op.drop_index("idx_suppliers_is_active", table_name="suppliers")
    op.drop_index("idx_suppliers_name", table_name="suppliers")
    op.drop_table("suppliers")
