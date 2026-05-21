from datetime import datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, field_validator, model_validator


class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    user: "UserOut"


class WorkdayHoursSettingUpdate(BaseModel):
    value: float


class WorkdayHoursSettingOut(BaseModel):
    value: float
    label: str


class StoreProfileSetup(BaseModel):
    store_name: str
    country: str
    currency: str
    store_type: str
    phone: Optional[str] = None
    address: Optional[str] = None
    logo_path: Optional[str] = None
    server_port: Optional[int] = None
    admin_name: str
    admin_username: str
    admin_password: str
    secret_question: str
    secret_answer: str
    secret_answer_confirm: str

    @field_validator("store_name", "country", "currency", "store_type", "admin_name", "admin_username", "secret_question")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("هذا الحقل مطلوب")
        return value

    @field_validator("admin_password")
    @classmethod
    def validate_admin_password(cls, value: str) -> str:
        if len(value or "") < 8:
            raise ValueError("كلمة المرور يجب أن تكون 8 أحرف على الأقل")
        return value

    @field_validator("secret_answer", "secret_answer_confirm")
    @classmethod
    def validate_secret_answer(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("إجابة الاستعادة مطلوبة")
        return value

    @model_validator(mode="after")
    def validate_secret_answer_match(self):
        if self.secret_answer.strip() != self.secret_answer_confirm.strip():
            raise ValueError("تأكيد إجابة الاستعادة غير مطابق")
        return self

    @field_validator("server_port")
    @classmethod
    def validate_server_port(cls, value: Optional[int]) -> Optional[int]:
        if value is None:
            return value
        if value < 1 or value > 65535:
            raise ValueError("منفذ السيرفر غير صالح")
        return value


class StoreProfileUpdate(BaseModel):
    store_name: Optional[str] = None
    country: Optional[str] = None
    currency: Optional[str] = None
    store_type: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    logo_path: Optional[str] = None

    @field_validator("store_name", "country", "currency", "store_type")
    @classmethod
    def validate_optional_required_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("هذا الحقل مطلوب")
        return value


class StoreProfileOut(BaseModel):
    id: int
    store_id: str
    store_name: str
    country: str
    currency: str
    store_type: str
    logo_path: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    initialized_at: datetime
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class StorefrontOut(BaseModel):
    initialized: bool
    setup_state: Optional[str] = None
    setup_reason: Optional[str] = None
    store_name: str
    country: Optional[str] = None
    currency: Optional[str] = None
    store_type: Optional[str] = None
    logo_path: Optional[str] = None
    logo_url: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    branding_revision: Optional[str] = None


class TelegramLauncherSettingsUpdate(BaseModel):
    telegram_enabled: bool
    telegram_auto_send: bool
    telegram_mode: str = "pdf"

    @field_validator("telegram_mode")
    @classmethod
    def validate_telegram_mode(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"pdf", "text"}:
            raise ValueError("نمط تيليجرام يجب أن يكون pdf أو text")
        return normalized


class TelegramLauncherSettingsOut(BaseModel):
    telegram_enabled: bool
    telegram_auto_send: bool
    telegram_mode: str
    bot_username: Optional[str] = None
    bot_status: str
    link: Optional[str] = None
    store_linked: bool = False
    store_linked_at: Optional[str] = None
    store_linked_username: Optional[str] = None


class LicenseStatusOut(BaseModel):
    license_id: Optional[str] = None
    sequence_number: Optional[int] = None
    store_id: Optional[str] = None
    installation_id: str
    license_type: str
    subscription_term: Optional[str] = None
    license_status: str
    plan: Optional[str] = None
    trial_started_at: Optional[str] = None
    trial_expires_at: Optional[str] = None
    activated_at: Optional[str] = None
    issued_at: Optional[str] = None
    expires_at: Optional[str] = None
    remaining_days: Optional[int] = None
    is_blocked: bool = False
    reason: Optional[str] = None
    status_reason: Optional[str] = None
    activation_request_url: Optional[str] = None
    consumed_at: Optional[str] = None
    last_seen_local_at: Optional[str] = None
    current_time_utc: Optional[str] = None
    time_source: Optional[str] = None
    time_sync_status: Optional[str] = None
    time_trusted: Optional[bool] = None
    time_reason: Optional[str] = None
    time_server: Optional[str] = None


class LicenseActivationIn(BaseModel):
    activation_key: str


class LauncherStatusOut(BaseModel):
    initialized: bool
    setup_state: Optional[str] = None
    setup_reason: Optional[str] = None
    has_admin: bool
    server_port: int
    runtime: dict
    store: Optional[StoreProfileOut] = None
    license: Optional[LicenseStatusOut] = None


class ManagerTelegramSetupStatusOut(BaseModel):
    bot_username: Optional[str] = None
    bot_token_configured: bool = False
    telegram_setup_problem: Optional[str] = None
    link: Optional[str] = None
    linked: bool = False
    manager_telegram_masked: Optional[str] = None
    manager_telegram_username: Optional[str] = None
    verified_at: Optional[str] = None


class AdminRecoveryStatusOut(BaseModel):
    available: bool
    host_only: bool = True
    has_admin: bool
    manager_telegram_linked: bool
    manager_telegram_masked: Optional[str] = None
    secret_question_configured: bool
    recovery_configured: bool
    store_id: Optional[str] = None
    installation_id: Optional[str] = None


class AdminRecoveryOtpRequestOut(BaseModel):
    ok: bool
    expires_in_seconds: int
    resend_cooldown_seconds: int
    manager_telegram_masked: Optional[str] = None


class AdminRecoveryOtpVerifyIn(BaseModel):
    otp: str


class AdminRecoveryOtpVerifyOut(BaseModel):
    ok: bool
    recovery_token: str
    secret_question: str


class AdminRecoverySecretVerifyIn(BaseModel):
    recovery_token: str
    answer: str


class AdminRecoverySecretVerifyOut(BaseModel):
    ok: bool
    admin_username: str
    admin_user_id: int


class AdminRecoveryResetIn(BaseModel):
    recovery_token: str
    new_password: str
    confirm_password: str
    new_username: Optional[str] = None

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, value: str) -> str:
        if len(value or "") < 8:
            raise ValueError("كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل")
        return value

    @model_validator(mode="after")
    def validate_password_match(self):
        if self.new_password != self.confirm_password:
            raise ValueError("تأكيد كلمة المرور غير مطابق")
        return self


class AdminRecoveryResetOut(BaseModel):
    ok: bool
    admin_username: str


class UserCreate(BaseModel):
    name: str
    username: str
    phone: Optional[str] = None
    password: str
    role: str = "cashier"
    cashier_number: Optional[int] = None


class UserUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    password: Optional[str] = None
    role: Optional[str] = None
    cashier_number: Optional[int] = None
    is_active: Optional[bool] = None


class UserOut(BaseModel):
    id: int
    name: str
    username: str
    phone: Optional[str]
    role: str
    cashier_number: Optional[int]
    is_active: bool

    model_config = ConfigDict(from_attributes=True)


class CategoryCreate(BaseModel):
    name: str
    icon: Optional[str] = None
    color: Optional[str] = None


class CategoryOut(BaseModel):
    id: int
    name: str
    icon: Optional[str]
    color: Optional[str]

    model_config = ConfigDict(from_attributes=True)


class BarcodeOut(BaseModel):
    id: int
    barcode: str

    model_config = ConfigDict(from_attributes=True)


class SupplierBase(BaseModel):
    name: str
    phone: Optional[str] = None
    contact_name: Optional[str] = None
    address: Optional[str] = None
    notes: Optional[str] = None
    is_active: bool = True

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("اسم المورد مطلوب")
        return value[:150]


class SupplierCreate(SupplierBase):
    pass


class SupplierUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    contact_name: Optional[str] = None
    address: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("اسم المورد مطلوب")
        return value[:150]


class SupplierOut(SupplierBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ProductCreate(BaseModel):
    barcode: Optional[str] = None
    name: str
    name_en: Optional[str] = None
    category_id: Optional[int] = None
    default_supplier_id: Optional[int] = None
    buy_price: float = 0
    price: float = 0
    stock: float = 0
    min_stock: float = 5
    unit: str = "قطعة"
    is_weighted: bool = False
    sell_without_barcode: bool = False
    is_sellable: bool = True
    track_expiry: bool = False
    track_batch: bool = False
    image: Optional[str] = None
    expiry_date: Optional[datetime] = None
    extra_barcodes: list[str] = []

    @field_validator("price")
    @classmethod
    def validate_price(cls, value: float) -> float:
        if value < 0:
            raise ValueError("سعر البيع لا يمكن أن يكون سالباً")
        return round(value, 2)

    @field_validator("buy_price")
    @classmethod
    def validate_buy_price(cls, value: float) -> float:
        if value < 0:
            raise ValueError("سعر الشراء لا يمكن أن يكون سالباً")
        return round(value, 2)

    @field_validator("stock", "min_stock")
    @classmethod
    def validate_stock_values(cls, value: float) -> float:
        if value < 0:
            raise ValueError("الكمية لا يمكن أن تكون سالبة")
        return round(value, 3)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("اسم المنتج مطلوب")
        return value[:200]

    @model_validator(mode="after")
    def validate_manual_price_product(self):
        clean_barcode = (self.barcode or "").strip()
        if self.is_weighted:
            self.barcode = None
            self.extra_barcodes = []
            if not str(self.unit or "").strip():
                raise ValueError("وحدة المخزون مطلوبة للمنتج الموزون")
            if self.price <= 0:
                raise ValueError("سعر الوحدة المرجعي يجب أن يكون أكبر من صفر للمنتج الموزون")
        elif self.sell_without_barcode:
            self.barcode = None
            self.extra_barcodes = []
        elif not clean_barcode:
            raise ValueError("الباركود مطلوب للمنتج العادي")
        if not self.is_weighted and self.price <= 0:
            raise ValueError("سعر البيع يجب أن يكون أكبر من صفر للمنتج العادي")
        return self


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    name_en: Optional[str] = None
    price: Optional[float] = None
    buy_price: Optional[float] = None
    stock: Optional[float] = None
    min_stock: Optional[float] = None
    category_id: Optional[int] = None
    default_supplier_id: Optional[int] = None
    unit: Optional[str] = None
    is_weighted: Optional[bool] = None
    sell_without_barcode: Optional[bool] = None
    is_sellable: Optional[bool] = None
    track_expiry: Optional[bool] = None
    track_batch: Optional[bool] = None
    image: Optional[str] = None
    expiry_date: Optional[datetime] = None
    is_active: Optional[bool] = None

    @field_validator("price")
    @classmethod
    def validate_price(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and value < 0:
            raise ValueError("سعر البيع لا يمكن أن يكون سالباً")
        return round(value, 2) if value is not None else value

    @field_validator("buy_price")
    @classmethod
    def validate_buy_price(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and value < 0:
            raise ValueError("سعر الشراء لا يمكن أن يكون سالباً")
        return round(value, 2) if value is not None else value

    @field_validator("stock", "min_stock")
    @classmethod
    def validate_optional_stock_values(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and value < 0:
            raise ValueError("الكمية لا يمكن أن تكون سالبة")
        return round(value, 3) if value is not None else value

    @model_validator(mode="after")
    def validate_manual_price_update(self):
        if self.is_weighted is True and self.unit is not None and not str(self.unit).strip():
            raise ValueError("وحدة المخزون مطلوبة للمنتج الموزون")
        if self.is_weighted is True and self.price is not None and self.price <= 0:
            raise ValueError("سعر الوحدة المرجعي يجب أن يكون أكبر من صفر للمنتج الموزون")
        if self.price is not None and self.price <= 0 and self.is_weighted is not True:
            raise ValueError("سعر البيع يجب أن يكون أكبر من صفر للمنتج العادي")
        return self


class ProductOut(BaseModel):
    id: int
    barcode: Optional[str]
    name: str
    name_en: Optional[str]
    category_id: Optional[int]
    default_supplier_id: Optional[int]
    buy_price: float
    price: float
    stock: float
    min_stock: float
    unit: str
    is_weighted: bool
    is_sellable: bool
    track_expiry: bool
    track_batch: bool
    image: Optional[str]
    expiry_date: Optional[datetime] = None
    is_active: bool
    extra_barcodes: list[BarcodeOut] = []

    model_config = ConfigDict(from_attributes=True)


class PrintableBarcodeOut(BaseModel):
    product_id: int
    product_name: str
    barcode: str
    source: str
    unit: Optional[str] = None
    price: float
    is_weighted: bool
    is_sellable: bool


class ReportsDashboardPeriodOut(BaseModel):
    preset: str
    date_from: str
    date_to: str
    label: str
    day_count: int


class ReportsDashboardKpiOut(BaseModel):
    gross_sales: float
    net_sales: float
    total_returns: float
    return_count: int
    invoice_count: int
    average_invoice_value: float
    low_stock_products_count: int
    near_expiry_products_count: int
    estimated_inventory_margin: Optional[float] = None
    top_selling_product_name: Optional[str] = None
    top_selling_product_qty: Optional[float] = None


class ReportsDashboardTimeSeriesPointOut(BaseModel):
    key: str
    label: str
    gross_sales: float = 0.0
    net_sales: float = 0.0
    returns: float = 0.0


class ReportsDashboardProductSeriesPointOut(BaseModel):
    product_id: int
    name: str
    barcode: Optional[str] = None
    category_name: Optional[str] = None
    sold_qty: float = 0.0
    returned_qty: float = 0.0
    net_qty: float = 0.0
    gross_revenue: float = 0.0
    returned_revenue: float = 0.0
    net_revenue: float = 0.0
    stock: Optional[float] = None
    min_stock: Optional[float] = None


class ReportsDashboardCategorySeriesPointOut(BaseModel):
    category_id: Optional[int] = None
    category_name: str
    sold_qty: float = 0.0
    returned_qty: float = 0.0
    net_qty: float = 0.0
    gross_revenue: float = 0.0
    returned_revenue: float = 0.0
    net_revenue: float = 0.0


class ReportsDashboardHourlySeriesPointOut(BaseModel):
    hour: int
    label: str
    invoices: int = 0
    gross_sales: float = 0.0


class ReportsDashboardPaymentMethodPointOut(BaseModel):
    payment_method: str
    label: str
    count: int
    amount: float


class ReportsDashboardAlertItemOut(BaseModel):
    id: int
    name: str
    barcode: Optional[str] = None
    stock: Optional[float] = None
    min_stock: Optional[float] = None
    expiry_date: Optional[str] = None
    days_left: Optional[int] = None
    status: str


class ReportsDashboardAlertsOut(BaseModel):
    low_stock_count: int
    out_of_stock_count: int
    near_expiry_count: int
    low_stock: list[ReportsDashboardAlertItemOut] = []
    near_expiry: list[ReportsDashboardAlertItemOut] = []


class ReportsDashboardInsightOut(BaseModel):
    id: str
    type: str
    tone: str
    title: str
    body: str
    basis: str


class ReportsDashboardTablesOut(BaseModel):
    top_products: list[ReportsDashboardProductSeriesPointOut] = []
    category_performance: list[ReportsDashboardCategorySeriesPointOut] = []
    payment_methods: list[ReportsDashboardPaymentMethodPointOut] = []


class ReportsDashboardSeriesOut(BaseModel):
    sales_over_time: list[ReportsDashboardTimeSeriesPointOut] = []
    returns_vs_sales: list[ReportsDashboardTimeSeriesPointOut] = []
    top_products: list[ReportsDashboardProductSeriesPointOut] = []
    category_performance: list[ReportsDashboardCategorySeriesPointOut] = []
    hourly_sales: list[ReportsDashboardHourlySeriesPointOut] = []
    payment_methods: list[ReportsDashboardPaymentMethodPointOut] = []


class ReportsDashboardOut(BaseModel):
    period: ReportsDashboardPeriodOut
    kpis: ReportsDashboardKpiOut
    series: ReportsDashboardSeriesOut
    insights: list[ReportsDashboardInsightOut] = []
    alerts: ReportsDashboardAlertsOut
    tables: ReportsDashboardTablesOut


class SessionOut(BaseModel):
    id: int
    session_token: str
    is_active: bool
    opened_at: datetime
    closed_at: Optional[datetime] = None
    last_activity_at: Optional[datetime] = None
    invoices_count: int
    total_sales: Decimal

    model_config = ConfigDict(from_attributes=True)


class CustomerTelegramStatusOut(BaseModel):
    id: Optional[int] = None
    customer_name: Optional[str] = None
    phone_number: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    telegram_activation_status: str
    telegram_status_label: str
    telegram_activated_at: Optional[datetime] = None
    activation_token_expiry: Optional[datetime] = None
    activation_url: Optional[str] = None
    activation_token: Optional[str] = None


class CustomerLookupOut(BaseModel):
    id: int
    customer_name: Optional[str] = None
    phone_number: str
    telegram_activation_status: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class CustomerRecordOut(BaseModel):
    id: int
    customer_name: Optional[str] = None
    phone_number: str
    telegram_activation_status: str
    telegram_status_label: str
    telegram_username: Optional[str] = None
    telegram_activated_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class CustomerActivationRequest(BaseModel):
    customer_name: Optional[str] = None
    phone_number: str
    session_token: str

    @field_validator("customer_name")
    @classmethod
    def normalize_customer_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value[:120] if value else None

    @field_validator("phone_number")
    @classmethod
    def normalize_phone(cls, value: str) -> str:
        digits = "".join(ch for ch in str(value or "") if ch.isdigit())
        if len(digits) < 7 or len(digits) > 15:
            raise ValueError("رقم الهاتف غير صالح")
        return digits

    @field_validator("session_token")
    @classmethod
    def validate_session_token(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("رمز الجلسة غير صالح")
        return value[:100]


class InvoiceItemCreate(BaseModel):
    product_id: int
    quantity: float
    price: float


class InvoiceCreate(BaseModel):
    items: list[InvoiceItemCreate]
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    payment_method: str = "cash"
    discount: float = 0
    notes: Optional[str] = None
    is_paid: bool = True
    offline_uuid: Optional[str] = None


class InvoiceItemOut(BaseModel):
    id: int
    product_id: int
    quantity: float
    price: float
    subtotal: float
    product_name: Optional[str] = None
    product_barcode: Optional[str] = None
    product_unit: Optional[str] = None
    product_unit_price: Optional[float] = None
    product_is_weighted: Optional[bool] = None

    model_config = ConfigDict(from_attributes=True)


class InvoiceOut(BaseModel):
    id: int
    cashier_id: int
    customer_name: Optional[str]
    customer_phone: Optional[str]
    payment_method: str
    total: float
    discount: float
    final_total: float
    invoice_sent_to_telegram: bool = False
    invoice_telegram_sent_at: Optional[datetime] = None
    invoice_telegram_delivery_status: Optional[str] = None
    is_cancelled: bool = False
    is_paid: bool = True
    is_returned: bool = False
    returned_amount: float = 0.0
    created_at: datetime
    items: list[InvoiceItemOut]

    model_config = ConfigDict(from_attributes=True)


class ReturnItemCreate(BaseModel):
    invoice_item_id: int
    quantity: float


class ReturnCreate(BaseModel):
    invoice_id: int
    items: list[ReturnItemCreate]
    reason: Optional[str] = None
    refund_method: str = "cash"


class ReturnItemOut(BaseModel):
    id: int
    product_id: int
    product_name: Optional[str] = None
    quantity: float
    price: float
    subtotal: float

    model_config = ConfigDict(from_attributes=True)


class ReturnOut(BaseModel):
    id: int
    original_invoice_id: int
    cashier_id: int
    total_refunded: float
    reason: Optional[str]
    refund_method: str
    created_at: datetime
    items: list[ReturnItemOut]

    model_config = ConfigDict(from_attributes=True)


class PurchaseItemIn(BaseModel):
    product_id: Optional[int] = None
    product_name: Optional[str] = None
    unit: Optional[str] = None
    category_id: Optional[int] = None
    min_stock: float = 5
    is_weighted: bool = False
    track_expiry: bool = False
    track_batch: bool = False
    quantity: float
    purchase_price: float
    selling_price: Optional[float] = None
    expiry_date: Optional[datetime] = None
    batch_number: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("quantity")
    @classmethod
    def validate_quantity(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("الكمية يجب أن تكون أكبر من صفر")
        return value

    @field_validator("product_name")
    @classmethod
    def validate_product_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value[:200] if value else None

    @field_validator("unit")
    @classmethod
    def validate_unit(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value[:20] if value else None

    @field_validator("min_stock")
    @classmethod
    def validate_min_stock(cls, value: float) -> float:
        if value < 0:
            raise ValueError("الحد الأدنى لا يمكن أن يكون سالبًا")
        return round(value, 3)

    @field_validator("purchase_price", "selling_price")
    @classmethod
    def validate_prices(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and value < 0:
            raise ValueError("السعر لا يمكن أن يكون سالباً")
        return round(value, 2) if value is not None else value

    @model_validator(mode="after")
    def validate_stock_item_reference(self):
        if self.product_id:
            return self
        if not self.product_name:
            raise ValueError("ÙŠØ¬Ø¨ Ø§Ø®ØªÙŠØ§Ø± ØµÙ†Ù Ù…ÙˆØ¬ÙˆØ¯ Ø£Ùˆ Ø¥Ø¯Ø®Ø§Ù„ Ø§Ø³Ù… ØµÙ†Ù Ø¬Ø¯ÙŠØ¯")
        if not self.unit:
            raise ValueError("ÙˆØ­Ø¯Ø© Ø§Ù„Ù…Ø®Ø²ÙˆÙ† Ù…Ø·Ù„ÙˆØ¨Ø© Ø¹Ù†Ø¯ Ø¥Ø¯Ø®Ø§Ù„ ØµÙ†Ù Ø¬Ø¯ÙŠØ¯")
        return self


class PurchaseCreate(BaseModel):
    supplier_id: int
    invoice_number: str
    purchase_date: datetime
    discount_amount: float = 0
    notes: Optional[str] = None
    items: list[PurchaseItemIn]

    @field_validator("invoice_number")
    @classmethod
    def validate_invoice_number(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("رقم فاتورة الشراء مطلوب")
        return value[:100]

    @field_validator("discount_amount")
    @classmethod
    def validate_discount(cls, value: float) -> float:
        if value < 0:
            raise ValueError("الخصم لا يمكن أن يكون سالباً")
        return round(value, 2)

    @model_validator(mode="after")
    def validate_items(self):
        if not self.items:
            raise ValueError("يجب إضافة صنف واحد على الأقل")
        return self


class PurchaseUpdate(BaseModel):
    supplier_id: Optional[int] = None
    invoice_number: Optional[str] = None
    purchase_date: Optional[datetime] = None
    discount_amount: Optional[float] = None
    notes: Optional[str] = None
    items: Optional[list[PurchaseItemIn]] = None

    @field_validator("invoice_number")
    @classmethod
    def validate_invoice_number(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("رقم فاتورة الشراء مطلوب")
        return value[:100]

    @field_validator("discount_amount")
    @classmethod
    def validate_discount(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and value < 0:
            raise ValueError("الخصم لا يمكن أن يكون سالباً")
        return round(value, 2) if value is not None else value


class PurchaseItemOut(BaseModel):
    id: int
    product_id: int
    product_name: Optional[str] = None
    unit: Optional[str] = None
    is_sellable: Optional[bool] = None
    quantity: float
    purchase_price: float
    selling_price: Optional[float] = None
    line_total: float
    expiry_date: Optional[datetime] = None
    batch_number: Optional[str] = None
    notes: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class PurchaseOut(BaseModel):
    id: int
    supplier_id: int
    supplier_name: Optional[str] = None
    invoice_number: str
    purchase_date: datetime
    status: str
    subtotal: float
    discount_amount: float
    total_amount: float
    notes: Optional[str] = None
    created_by: int
    confirmed_by: Optional[int] = None
    confirmed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    items: list[PurchaseItemOut]

    model_config = ConfigDict(from_attributes=True)


class ProductSetupCandidateOut(BaseModel):
    id: int
    name: str
    unit: Optional[str] = None
    stock: float
    barcode: Optional[str] = None
    supplier_name: Optional[str] = None
    category_name: Optional[str] = None
    is_weighted: bool
    is_sellable: bool
    track_expiry: bool
    track_batch: bool

    model_config = ConfigDict(from_attributes=True)


class ProductPrepareForSale(BaseModel):
    barcode: Optional[str] = None
    name: Optional[str] = None
    category_id: Optional[int] = None
    buy_price: Optional[float] = None
    price: float
    min_stock: Optional[float] = None
    unit: Optional[str] = None
    is_weighted: bool = False
    sell_without_barcode: bool = False
    track_expiry: bool = False
    track_batch: bool = False
    expiry_date: Optional[datetime] = None
    extra_barcodes: list[str] = []

    @field_validator("name")
    @classmethod
    def validate_prepare_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("Ø§Ø³Ù… Ø§Ù„Ù…Ù†ØªØ¬ Ù…Ø·Ù„ÙˆØ¨")
        return value[:200]

    @field_validator("buy_price", "price")
    @classmethod
    def validate_prepare_price(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and value < 0:
            raise ValueError("Ø§Ù„Ø³Ø¹Ø± Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø£Ù† ÙŠÙƒÙˆÙ† Ø³Ø§Ù„Ø¨Ø§Ù‹")
        return round(value, 2) if value is not None else value

    @field_validator("min_stock")
    @classmethod
    def validate_prepare_min_stock(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and value < 0:
            raise ValueError("Ø§Ù„Ø­Ø¯ Ø§Ù„Ø£Ø¯Ù†Ù‰ Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø£Ù† ÙŠÙƒÙˆÙ† Ø³Ø§Ù„Ø¨Ù‹Ø§")
        return round(value, 3) if value is not None else value

    @model_validator(mode="after")
    def validate_prepare_payload(self):
        clean_barcode = (self.barcode or "").strip()
        if self.is_weighted:
            self.barcode = None
            self.extra_barcodes = []
            if not str(self.unit or "").strip():
                raise ValueError("ÙˆØ­Ø¯Ø© Ø§Ù„Ù…Ø®Ø²ÙˆÙ† Ù…Ø·Ù„ÙˆØ¨Ø© Ù„Ù„Ù…Ù†ØªØ¬ Ø§Ù„Ù…ÙˆØ²ÙˆÙ†")
            if self.price <= 0:
                raise ValueError("Ø³Ø¹Ø± Ø§Ù„ÙˆØ­Ø¯Ø© Ø§Ù„Ù…Ø±Ø¬Ø¹ÙŠ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø£ÙƒØ¨Ø± Ù…Ù† ØµÙØ±")
            return self
        if self.sell_without_barcode:
            self.barcode = None
            self.extra_barcodes = []
            if self.price <= 0:
                raise ValueError("Ø³Ø¹Ø± Ø§Ù„Ø¨ÙŠØ¹ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø£ÙƒØ¨Ø± Ù…Ù† ØµÙØ±")
            return self
        if not clean_barcode:
            raise ValueError("Ø§Ù„Ø¨Ø§Ø±ÙƒÙˆØ¯ Ù…Ø·Ù„ÙˆØ¨")
        if self.price <= 0:
            raise ValueError("Ø³Ø¹Ø± Ø§Ù„Ø¨ÙŠØ¹ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø£ÙƒØ¨Ø± Ù…Ù† ØµÙØ±")
        return self


class BatchOut(BaseModel):
    id: int
    product_id: int
    batch_number: Optional[str]
    expiry_date: Optional[datetime] = None
    received_quantity: float
    available_quantity: float
    purchase_price: float
    selling_price: Optional[float] = None
    status: str

    model_config = ConfigDict(from_attributes=True)


class StockMovementOut(BaseModel):
    id: int
    product_id: int
    product_name: Optional[str] = None
    batch_id: Optional[int] = None
    batch_number: Optional[str] = None
    movement_type: str
    quantity: float
    unit_cost: Optional[float] = None
    reference_type: str
    reference_id: Optional[int] = None
    reason: Optional[str] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class StockCountItemIn(BaseModel):
    product_id: int
    batch_id: Optional[int] = None
    counted_quantity: float
    adjustment_reason: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("counted_quantity")
    @classmethod
    def validate_counted_quantity(cls, value: float) -> float:
        if value < 0:
            raise ValueError("counted_quantity cannot be negative")
        return value


class StockCountCreate(BaseModel):
    count_type: str
    count_date: datetime
    notes: Optional[str] = None
    items: list[StockCountItemIn]

    @field_validator("count_type")
    @classmethod
    def validate_count_type(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in {"daily", "monthly"}:
            raise ValueError("نوع الجرد يجب أن يكون daily أو monthly")
        return value

    @model_validator(mode="after")
    def validate_items(self):
        if not self.items:
            raise ValueError("يجب إضافة صنف واحد على الأقل")
        return self


class StockCountUpdate(BaseModel):
    notes: Optional[str] = None
    items: Optional[list[StockCountItemIn]] = None


class StockCountItemOut(BaseModel):
    id: int
    product_id: int
    product_name: Optional[str] = None
    batch_id: Optional[int] = None
    batch_number: Optional[str] = None
    system_quantity: float
    counted_quantity: float
    difference_quantity: float
    adjustment_reason: Optional[str] = None
    notes: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class StockCountOut(BaseModel):
    id: int
    count_type: str
    status: str
    count_date: datetime
    notes: Optional[str] = None
    created_by: int
    approved_by: Optional[int] = None
    approved_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    items: list[StockCountItemOut]

    model_config = ConfigDict(from_attributes=True)
