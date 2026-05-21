"""attendance module fields and notes

Revision ID: 20260325_attendance_module
Revises: 0c608ee58755
Create Date: 2026-03-25
"""
from alembic import op
import sqlalchemy as sa

revision = '20260325_attendance_module'
down_revision = '0c608ee58755'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('sessions') as batch_op:
        batch_op.add_column(sa.Column('last_presence_at', sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column('ended_by', sa.String(length=50), nullable=True, server_default='active'))

    op.execute("UPDATE sessions SET last_presence_at = COALESCE(last_activity_at, opened_at)")
    op.create_table(
        'attendance_notes',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('year', sa.Integer(), nullable=False),
        sa.Column('month', sa.Integer(), nullable=False),
        sa.Column('day', sa.Integer(), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('user_id', 'year', 'month', 'day', name='uq_attendance_notes_user_day'),
    )
    op.create_index('idx_attendance_notes_user_month', 'attendance_notes', ['user_id', 'year', 'month'])


def downgrade() -> None:
    op.drop_index('idx_attendance_notes_user_month', table_name='attendance_notes')
    op.drop_table('attendance_notes')
    with op.batch_alter_table('sessions') as batch_op:
        batch_op.drop_column('ended_by')
        batch_op.drop_column('last_presence_at')
