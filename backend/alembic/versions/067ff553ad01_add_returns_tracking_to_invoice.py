"""Add returns tracking to Invoice

Revision ID: 067ff553ad01
Revises: 002
Create Date: 2026-03-23 21:32:56.073217

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '067ff553ad01'
down_revision: Union[str, Sequence[str], None] = '002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('invoices', sa.Column('is_returned', sa.Boolean(), nullable=True))
    op.add_column('invoices', sa.Column('returned_amount', sa.Numeric(precision=10, scale=2), nullable=True))
    # ### end Alembic commands ###


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('invoices', 'returned_amount')
    op.drop_column('invoices', 'is_returned')
    # ### end Alembic commands ###
