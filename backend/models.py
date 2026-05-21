from datetime import datetime
import enum

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.orm import relationship

from database import Base
from services.timezone_service import utc_now


class RoleEnum(str, enum.Enum):
    admin = "admin"
    supervisor = "supervisor"
    cashier = "cashier"


class PurchaseStatusEnum(str, enum.Enum):
    draft = "draft"
    confirmed = "confirmed"
    cancelled = "cancelled"


class BatchStatusEnum(str, enum.Enum):
    active = "active"
    depleted = "depleted"
    expired = "expired"


class StockMovementTypeEnum(str, enum.Enum):
    purchase = "purchase"
    sale = "sale"
    sale_return = "sale_return"
    adjustment_in = "adjustment_in"
    adjustment_out = "adjustment_out"
    opening_balance = "opening_balance"
    writeoff = "writeoff"


class StockReferenceTypeEnum(str, enum.Enum):
    purchase = "purchase"
    invoice = "invoice"
    return_ref = "return"
    stock_count = "stock_count"
    manual = "manual"


class StockCountTypeEnum(str, enum.Enum):
    daily = "daily"
    monthly = "monthly"


class StockCountStatusEnum(str, enum.Enum):
    draft = "draft"
    submitted = "submitted"
    approved = "approved"
    cancelled = "cancelled"


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)
    username = Column(String(50), unique=True, nullable=False)
    phone = Column(String(20))
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(20), default="cashier")
    cashier_number = Column(Integer)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=utc_now)

    sessions = relationship("Session", back_populates="user")
    invoices = relationship("Invoice", back_populates="cashier")


class Session(Base):
    __tablename__ = "sessions"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    session_token = Column(String(100), unique=True)
    mobile_bootstrap_token = Column(String(255), nullable=True)
    mobile_bootstrap_expires_at = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)
    opened_at = Column(DateTime, default=utc_now)
    closed_at = Column(DateTime, nullable=True)
    last_activity_at = Column(DateTime, nullable=True)
    invoices_count = Column(Integer, default=0)
    total_sales = Column(Numeric(10, 2), default=0)
    disconnect_reason = Column(String(50), default="active")
    is_abnormal = Column(Boolean, default=False)

    user = relationship("User", back_populates="sessions")

    __table_args__ = (
        Index("idx_sessions_token", "session_token"),
        Index("idx_sessions_user_id", "user_id"),
        Index("idx_sessions_mobile_bootstrap_token", "mobile_bootstrap_token"),
    )


class Category(Base):
    __tablename__ = "categories"
    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)
    icon = Column(String(50))
    color = Column(String(20))

    products = relationship("Product", back_populates="category")


class Supplier(Base):
    __tablename__ = "suppliers"
    id = Column(Integer, primary_key=True)
    name = Column(String(150), nullable=False)
    phone = Column(String(30))
    contact_name = Column(String(100))
    address = Column(String(255))
    notes = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    products_default = relationship("Product", back_populates="default_supplier")
    purchases = relationship("Purchase", back_populates="supplier")
    batches = relationship("ProductBatch", back_populates="supplier")

    __table_args__ = (
        Index("idx_suppliers_name", "name"),
        Index("idx_suppliers_is_active", "is_active"),
    )


class Product(Base):
    __tablename__ = "products"
    id = Column(Integer, primary_key=True)
    barcode = Column(String(100), unique=True, nullable=True)
    name = Column(String(200), nullable=False)
    name_en = Column(String(200))
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    default_supplier_id = Column(Integer, ForeignKey("suppliers.id"), nullable=True)
    buy_price = Column(Numeric(10, 2), default=0)
    price = Column(Numeric(10, 2), nullable=False)
    stock = Column(Numeric(10, 3), default=0)
    min_stock = Column(Numeric(10, 3), default=5)
    unit = Column(String(20), default="قطعة")
    is_weighted = Column(Boolean, default=False)
    is_sellable = Column(Boolean, default=True)
    track_expiry = Column(Boolean, default=False)
    track_batch = Column(Boolean, default=False)
    image = Column(String(500))
    expiry_date = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    category = relationship("Category", back_populates="products")
    default_supplier = relationship("Supplier", back_populates="products_default")
    invoice_items = relationship("InvoiceItem", back_populates="product")
    extra_barcodes = relationship("ProductBarcode", back_populates="product", cascade="all, delete-orphan")
    purchase_items = relationship("PurchaseItem", back_populates="product")
    batches = relationship("ProductBatch", back_populates="product")
    stock_movements = relationship("StockMovement", back_populates="product")
    stock_count_items = relationship("StockCountItem", back_populates="product")

    __table_args__ = (
        Index("idx_products_barcode", "barcode"),
        Index("idx_products_is_active", "is_active"),
        Index("idx_products_is_sellable", "is_sellable"),
        Index("idx_products_default_supplier", "default_supplier_id"),
    )


class ProductBarcode(Base):
    __tablename__ = "product_barcodes"
    id = Column(Integer, primary_key=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    barcode = Column(String(100), unique=True, nullable=False)
    created_at = Column(DateTime, default=utc_now)

    product = relationship("Product", back_populates="extra_barcodes")

    __table_args__ = (
        Index("idx_product_barcodes_barcode", "barcode"),
    )


class Customer(Base):
    __tablename__ = "customers"
    id = Column(Integer, primary_key=True)
    customer_name = Column(String(120), nullable=True)
    phone_number = Column(String(30), unique=True, nullable=False)
    telegram_chat_id = Column(String(50), nullable=True)
    telegram_activation_status = Column(String(20), default="inactive", nullable=False)
    telegram_username = Column(String(100), nullable=True)
    telegram_activated_at = Column(DateTime, nullable=True)
    last_activation_token = Column(String(120), nullable=True)
    activation_token_expiry = Column(DateTime, nullable=True)
    last_activation_requested_at = Column(DateTime, nullable=True)
    pending_cashier_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    pending_session_token = Column(String(100), nullable=True)
    activation_error_message = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    pending_cashier = relationship("User")

    __table_args__ = (
        Index("idx_customers_phone_number", "phone_number"),
        Index("idx_customers_telegram_status", "telegram_activation_status"),
    )


class Invoice(Base):
    __tablename__ = "invoices"
    id = Column(Integer, primary_key=True)
    cashier_id = Column(Integer, ForeignKey("users.id"))
    customer_name = Column(String(100))
    customer_phone = Column(String(20))
    invoice_sent_to_telegram = Column(Boolean, default=False)
    invoice_telegram_sent_at = Column(DateTime, nullable=True)
    invoice_telegram_delivery_status = Column(String(20), nullable=True)
    payment_method = Column(String(20), default="cash")
    total = Column(Numeric(10, 2), default=0)
    discount = Column(Numeric(10, 2), default=0)
    tax_rate = Column(Numeric(5, 2), default=0)
    tax_amount = Column(Numeric(10, 2), default=0)
    final_total = Column(Numeric(10, 2), default=0)
    notes = Column(Text)
    is_cancelled = Column(Boolean, default=False)
    is_paid = Column(Boolean, default=True)
    is_returned = Column(Boolean, default=False)
    returned_amount = Column(Numeric(10, 2), default=0)
    offline_uuid = Column(String(50), unique=True, nullable=True)
    created_at = Column(DateTime, default=utc_now)

    cashier = relationship("User", back_populates="invoices")
    items = relationship("InvoiceItem", back_populates="invoice")

    __table_args__ = (
        Index("idx_invoices_created_at", "created_at"),
        Index("idx_invoices_cashier_id", "cashier_id"),
        Index("idx_invoices_is_cancelled", "is_cancelled"),
        Index("idx_invoices_is_paid", "is_paid"),
    )


class InvoiceItem(Base):
    __tablename__ = "invoice_items"
    id = Column(Integer, primary_key=True)
    invoice_id = Column(Integer, ForeignKey("invoices.id"))
    product_id = Column(Integer, ForeignKey("products.id"))
    quantity = Column(Numeric(10, 3), default=1, nullable=False)
    price = Column(Numeric(10, 2), nullable=False)
    subtotal = Column(Numeric(10, 2), nullable=False)

    invoice = relationship("Invoice", back_populates="items")
    product = relationship("Product", back_populates="invoice_items")
    return_items = relationship("InvoiceReturnItem", back_populates="original_item")
    batch_allocations = relationship("InvoiceItemBatchAllocation", back_populates="invoice_item", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_invoice_items_invoice_id", "invoice_id"),
        Index("idx_invoice_items_product_id", "product_id"),
    )


class InvoiceItemBatchAllocation(Base):
    __tablename__ = "invoice_item_batch_allocations"
    id = Column(Integer, primary_key=True)
    invoice_item_id = Column(Integer, ForeignKey("invoice_items.id", ondelete="CASCADE"), nullable=False)
    batch_id = Column(Integer, ForeignKey("product_batches.id"), nullable=False)
    quantity = Column(Numeric(10, 3), nullable=False)
    returned_quantity = Column(Numeric(10, 3), nullable=False, default=0)
    created_at = Column(DateTime, default=utc_now)

    invoice_item = relationship("InvoiceItem", back_populates="batch_allocations")
    batch = relationship("ProductBatch", back_populates="invoice_item_allocations")

    __table_args__ = (
        Index("idx_invoice_item_batch_allocations_item_id", "invoice_item_id"),
        Index("idx_invoice_item_batch_allocations_batch_id", "batch_id"),
    )


class InvoiceReturn(Base):
    __tablename__ = "invoice_returns"
    id = Column(Integer, primary_key=True)
    original_invoice_id = Column(Integer, ForeignKey("invoices.id"), nullable=False)
    cashier_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    total_refunded = Column(Numeric(10, 2), default=0)
    reason = Column(Text, nullable=True)
    refund_method = Column(String(20), default="cash")
    created_at = Column(DateTime, default=utc_now)

    original_invoice = relationship("Invoice", foreign_keys=[original_invoice_id])
    cashier = relationship("User", foreign_keys=[cashier_id])
    items = relationship("InvoiceReturnItem", back_populates="invoice_return", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_returns_invoice_id", "original_invoice_id"),
        Index("idx_returns_cashier_id", "cashier_id"),
        Index("idx_returns_created_at", "created_at"),
    )


class InvoiceReturnItem(Base):
    __tablename__ = "invoice_return_items"
    id = Column(Integer, primary_key=True)
    return_id = Column(Integer, ForeignKey("invoice_returns.id"), nullable=False)
    invoice_item_id = Column(Integer, ForeignKey("invoice_items.id"), nullable=False)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    quantity = Column(Numeric(10, 3), nullable=False)
    price = Column(Numeric(10, 2), nullable=False)
    subtotal = Column(Numeric(10, 2), nullable=False)

    invoice_return = relationship("InvoiceReturn", back_populates="items")
    product = relationship("Product")
    original_item = relationship("InvoiceItem", foreign_keys=[invoice_item_id], back_populates="return_items")

    __table_args__ = (
        Index("idx_return_items_return_id", "return_id"),
        Index("idx_return_items_product_id", "product_id"),
        Index("idx_return_items_invoice_item_id", "invoice_item_id"),
    )


class Purchase(Base):
    __tablename__ = "purchases"
    id = Column(Integer, primary_key=True)
    supplier_id = Column(Integer, ForeignKey("suppliers.id"), nullable=False)
    invoice_number = Column(String(100), nullable=False)
    purchase_date = Column(DateTime, default=utc_now, nullable=False)
    status = Column(String(20), default=PurchaseStatusEnum.draft.value, nullable=False)
    subtotal = Column(Numeric(12, 2), default=0)
    discount_amount = Column(Numeric(12, 2), default=0)
    total_amount = Column(Numeric(12, 2), default=0)
    notes = Column(Text)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    confirmed_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    confirmed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    supplier = relationship("Supplier", back_populates="purchases")
    creator = relationship("User", foreign_keys=[created_by])
    confirmer = relationship("User", foreign_keys=[confirmed_by])
    items = relationship("PurchaseItem", back_populates="purchase", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_purchases_supplier_id", "supplier_id"),
        Index("idx_purchases_purchase_date", "purchase_date"),
        Index("idx_purchases_status", "status"),
        Index("idx_purchases_invoice_number", "invoice_number"),
    )


class PurchaseItem(Base):
    __tablename__ = "purchase_items"
    id = Column(Integer, primary_key=True)
    purchase_id = Column(Integer, ForeignKey("purchases.id", ondelete="CASCADE"), nullable=False)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    quantity = Column(Numeric(10, 3), nullable=False)
    purchase_price = Column(Numeric(10, 2), nullable=False)
    selling_price = Column(Numeric(10, 2), nullable=True)
    line_total = Column(Numeric(12, 2), nullable=False)
    expiry_date = Column(DateTime, nullable=True)
    batch_number = Column(String(100), nullable=True)
    notes = Column(Text, nullable=True)

    purchase = relationship("Purchase", back_populates="items")
    product = relationship("Product", back_populates="purchase_items")
    batches = relationship("ProductBatch", back_populates="purchase_item")

    __table_args__ = (
        Index("idx_purchase_items_purchase_id", "purchase_id"),
        Index("idx_purchase_items_product_id", "product_id"),
    )


class ProductBatch(Base):
    __tablename__ = "product_batches"
    id = Column(Integer, primary_key=True)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    purchase_item_id = Column(Integer, ForeignKey("purchase_items.id"), nullable=True)
    supplier_id = Column(Integer, ForeignKey("suppliers.id"), nullable=True)
    batch_number = Column(String(100), nullable=True)
    expiry_date = Column(DateTime, nullable=True)
    received_quantity = Column(Numeric(10, 3), nullable=False)
    available_quantity = Column(Numeric(10, 3), nullable=False)
    purchase_price = Column(Numeric(10, 2), nullable=False)
    selling_price = Column(Numeric(10, 2), nullable=True)
    received_at = Column(DateTime, default=utc_now, nullable=False)
    status = Column(String(20), default=BatchStatusEnum.active.value, nullable=False)
    created_at = Column(DateTime, default=utc_now)

    product = relationship("Product", back_populates="batches")
    purchase_item = relationship("PurchaseItem", back_populates="batches")
    supplier = relationship("Supplier", back_populates="batches")
    stock_movements = relationship("StockMovement", back_populates="batch")
    stock_count_items = relationship("StockCountItem", back_populates="batch")
    invoice_item_allocations = relationship("InvoiceItemBatchAllocation", back_populates="batch")

    __table_args__ = (
        Index("idx_product_batches_product_id", "product_id"),
        Index("idx_product_batches_expiry_date", "expiry_date"),
        Index("idx_product_batches_status", "status"),
    )


class StockMovement(Base):
    __tablename__ = "stock_movements"
    id = Column(Integer, primary_key=True)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    batch_id = Column(Integer, ForeignKey("product_batches.id"), nullable=True)
    movement_type = Column(String(30), nullable=False)
    quantity = Column(Numeric(10, 3), nullable=False)
    unit_cost = Column(Numeric(10, 2), nullable=True)
    reference_type = Column(String(30), nullable=False)
    reference_id = Column(Integer, nullable=True)
    reason = Column(Text, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)

    product = relationship("Product", back_populates="stock_movements")
    batch = relationship("ProductBatch", back_populates="stock_movements")
    creator = relationship("User")

    __table_args__ = (
        Index("idx_stock_movements_product_id", "product_id"),
        Index("idx_stock_movements_batch_id", "batch_id"),
        Index("idx_stock_movements_created_at", "created_at"),
        Index("idx_stock_movements_reference", "reference_type", "reference_id"),
    )


class StockCount(Base):
    __tablename__ = "stock_counts"
    id = Column(Integer, primary_key=True)
    count_type = Column(String(20), nullable=False)
    status = Column(String(20), default=StockCountStatusEnum.draft.value, nullable=False)
    count_date = Column(DateTime, nullable=False)
    notes = Column(Text, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    approved_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    creator = relationship("User", foreign_keys=[created_by])
    approver = relationship("User", foreign_keys=[approved_by])
    items = relationship("StockCountItem", back_populates="stock_count", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_stock_counts_count_date", "count_date"),
        Index("idx_stock_counts_status", "status"),
    )


class StockCountItem(Base):
    __tablename__ = "stock_count_items"
    id = Column(Integer, primary_key=True)
    stock_count_id = Column(Integer, ForeignKey("stock_counts.id", ondelete="CASCADE"), nullable=False)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)
    batch_id = Column(Integer, ForeignKey("product_batches.id"), nullable=True)
    system_quantity = Column(Numeric(10, 3), nullable=False)
    counted_quantity = Column(Numeric(10, 3), nullable=False)
    difference_quantity = Column(Numeric(10, 3), nullable=False)
    adjustment_reason = Column(Text, nullable=True)
    notes = Column(Text, nullable=True)

    stock_count = relationship("StockCount", back_populates="items")
    product = relationship("Product", back_populates="stock_count_items")
    batch = relationship("ProductBatch", back_populates="stock_count_items")

    __table_args__ = (
        Index("idx_stock_count_items_stock_count_id", "stock_count_id"),
        Index("idx_stock_count_items_product_id", "product_id"),
    )


class StoreProfile(Base):
    __tablename__ = "store_profiles"
    id = Column(Integer, primary_key=True)
    store_id = Column(String(64), unique=True, nullable=False)
    store_name = Column(String(150), nullable=False)
    country = Column(String(100), nullable=False)
    currency = Column(String(20), nullable=False)
    store_type = Column(String(40), nullable=False)
    logo_path = Column(String(500), nullable=True)
    phone = Column(String(40), nullable=True)
    address = Column(String(255), nullable=True)
    initialized_at = Column(DateTime, default=utc_now, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        Index("idx_store_profiles_store_id", "store_id"),
    )


class SystemSetting(Base):
    __tablename__ = "system_settings"
    id = Column(Integer, primary_key=True)
    key = Column(String(100), unique=True, nullable=False)
    value = Column(Text)
    description = Column(String(255))
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
