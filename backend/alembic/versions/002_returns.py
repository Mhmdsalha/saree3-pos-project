"""add invoice_returns + invoice_return_items tables

Revision ID: 002
Revises: 001
Create Date: 2025-01-02
"""
from alembic import op
import sqlalchemy as sa

revision     = "002"
down_revision = "001"
branch_labels = None
depends_on    = None


def upgrade() -> None:
    op.create_table(
        "invoice_returns",
        sa.Column("id",                  sa.Integer(),      primary_key=True),
        sa.Column("original_invoice_id", sa.Integer(),      sa.ForeignKey("invoices.id"), nullable=False),
        sa.Column("cashier_id",          sa.Integer(),      sa.ForeignKey("users.id"),    nullable=False),
        sa.Column("total_refunded",      sa.Numeric(10,2),  nullable=True, server_default="0"),
        sa.Column("reason",              sa.Text(),         nullable=True),
        sa.Column("refund_method",       sa.String(20),     nullable=True, server_default="cash"),
        sa.Column("created_at",          sa.DateTime(),     nullable=True),
    )
    op.create_index("idx_returns_invoice_id", "invoice_returns", ["original_invoice_id"])
    op.create_index("idx_returns_cashier_id", "invoice_returns", ["cashier_id"])
    op.create_index("idx_returns_created_at", "invoice_returns", ["created_at"])

    op.create_table(
        "invoice_return_items",
        sa.Column("id",              sa.Integer(),     primary_key=True),
        sa.Column("return_id",       sa.Integer(),     sa.ForeignKey("invoice_returns.id"), nullable=False),
        sa.Column("invoice_item_id", sa.Integer(),     sa.ForeignKey("invoice_items.id"),   nullable=False),
        sa.Column("product_id",      sa.Integer(),     sa.ForeignKey("products.id"),        nullable=False),
        sa.Column("quantity",        sa.Numeric(10,3), nullable=False),
        sa.Column("price",           sa.Numeric(10,2), nullable=False),
        sa.Column("subtotal",        sa.Numeric(10,2), nullable=False),
    )
    op.create_index("idx_return_items_return_id",  "invoice_return_items", ["return_id"])
    op.create_index("idx_return_items_product_id", "invoice_return_items", ["product_id"])


def downgrade() -> None:
    op.drop_table("invoice_return_items")
    op.drop_table("invoice_returns")
