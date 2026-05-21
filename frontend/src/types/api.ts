export type UserRole = 'admin' | 'supervisor' | 'cashier'

export type Category = {
  id: number
  name: string
}

export type Supplier = {
  id: number
  name: string
  phone?: string | null
  contact_name?: string | null
  address?: string | null
  notes?: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type User = {
  id: number
  username: string
  name: string
  role: UserRole
  phone?: string | null
  cashier_number?: string | null
  is_active?: boolean
}

export type UserCreatePayload = {
  name: string
  username: string
  phone?: string | null
  password: string
  role: UserRole
  cashier_number?: number | null
}

export type UserUpdatePayload = {
  name?: string
  phone?: string | null
  password?: string | null
  role?: UserRole
  cashier_number?: number | null
  is_active?: boolean
}

export type LoginResponse = {
  access_token: string
  token_type: string
  user: User
}

export type WorkdayHoursSetting = {
  value: number
  label: string
}

export type Storefront = {
  initialized: boolean
  store_name: string
  country?: string | null
  currency?: string | null
  store_type?: string | null
  logo_path?: string | null
  logo_url?: string | null
  phone?: string | null
  address?: string | null
  branding_revision?: string | null
}

export type Product = {
  id: number
  barcode?: string | null
  name: string
  name_en?: string | null
  category_id?: number | null
  default_supplier_id?: number | null
  price: number
  stock: number
  buy_price?: number | null
  unit?: string | null
  min_stock?: number | null
  is_weighted?: boolean
  is_sellable?: boolean
  is_active?: boolean
  track_expiry?: boolean
  track_batch?: boolean
  expiry_date?: string | null
  extra_barcodes?: Array<{
    id?: number
    barcode: string
  }>
}

export type InvoiceCreatePayload = {
  items: Array<{
    product_id: number
    quantity: number
    price: number
  }>
  customer_name: string | null
  customer_phone: string | null
  payment_method: 'cash' | 'card' | 'digital'
  discount: number
  notes?: string | null
  is_paid: true
  offline_uuid?: string | null
}

export type InvoiceOut = {
  id: number
  cashier_id?: number
  cashier_name?: string | null
  customer_name?: string | null
  customer_phone?: string | null
  payment_method: 'cash' | 'card' | 'digital'
  total: number
  discount: number
  final_total: number
  invoice_sent_to_telegram?: boolean
  invoice_telegram_sent_at?: string | null
  invoice_telegram_delivery_status?: string | null
  returned_amount?: number
  net_total?: number
  is_cancelled?: boolean
  is_paid?: boolean
  is_returned?: boolean
  created_at: string
  items: Array<{
    id: number
    product_id: number
    quantity: number
    price: number
    subtotal: number
    product_name?: string | null
    product_barcode?: string | null
    product_unit?: string | null
    product_unit_price?: number | null
    product_is_weighted?: boolean | null
  }>
}

export type PaginatedInvoicesResponse = {
  items: InvoiceOut[]
  total: number
  page: number
  size: number
  pages: number
  has_next: boolean
  has_prev: boolean
}

export type ProductCreatePayload = {
  barcode?: string | null
  name: string
  category_id: number | null
  buy_price: number
  price: number
  stock: number
  min_stock: number
  unit: string
  is_weighted: boolean
  sell_without_barcode?: boolean
  track_expiry: boolean
  track_batch: boolean
  expiry_date: string | null
  extra_barcodes: string[]
  is_sellable?: boolean
}

export type CustomerTelegramStatus = {
  id?: number | null
  customer_name?: string | null
  phone_number?: string | null
  telegram_chat_id?: string | null
  telegram_activation_status: 'inactive' | 'pending' | 'activated' | 'failed' | 'expired'
  telegram_status_label: string
  telegram_activated_at?: string | null
  activation_token_expiry?: string | null
  activation_url?: string | null
  activation_token?: string | null
}

export type CustomerLookup = {
  id: number
  customer_name?: string | null
  phone_number: string
  telegram_activation_status?: 'inactive' | 'pending' | 'activated' | 'failed' | 'expired' | string | null
}

export type CustomerRecord = {
  id: number
  customer_name?: string | null
  phone_number: string
  telegram_activation_status: 'inactive' | 'pending' | 'activated' | 'failed' | 'expired' | string
  telegram_status_label: string
  telegram_username?: string | null
  telegram_activated_at?: string | null
  created_at: string
  updated_at: string
}

export type InventoryOverview = {
  summary: {
    total_products: number
    low_stock_count: number
    out_of_stock: number
    total_buy_value: number
    total_sell_value: number
    potential_profit: number
  }
  items: Array<{
    id: number
    barcode: string
    name: string
    category_id?: number | null
    category_name?: string | null
    supplier_id?: number | null
    supplier_name?: string | null
    stock: number
    min_stock: number
    unit: string
    buy_price: number
    price: number
    buy_value: number
    sell_value: number
      track_expiry: boolean
      track_batch: boolean
      is_sellable?: boolean
      status: 'out' | 'low' | 'ok'
  }>
}

export type ProductSetupCandidate = {
  id: number
  name: string
  unit?: string | null
  stock: number
  barcode?: string | null
  supplier_name?: string | null
  category_name?: string | null
  is_weighted: boolean
  is_sellable: boolean
  track_expiry: boolean
  track_batch: boolean
}

export type ProductPrepareForSalePayload = {
  barcode?: string | null
  name?: string | null
  category_id?: number | null
  buy_price?: number | null
  price: number
  min_stock?: number | null
  unit?: string | null
  is_weighted: boolean
  sell_without_barcode?: boolean
  track_expiry: boolean
  track_batch: boolean
  expiry_date?: string | null
  extra_barcodes: string[]
}

export type PrintableBarcodeResponse = {
  product_id: number
  product_name: string
  barcode: string
  source: 'primary' | 'extra_existing' | 'extra_generated' | string
  unit?: string | null
  price: number
  is_weighted: boolean
  is_sellable: boolean
}

export type InventoryBatch = {
  id: number
  product_id: number
  product_name?: string | null
  supplier_name?: string | null
  batch_number?: string | null
  expiry_date?: string | null
  received_quantity: number
  available_quantity: number
  purchase_price: number
  selling_price?: number | null
  status: string
  received_at?: string | null
}

export type StockMovement = {
  id: number
  product_id: number
  product_name?: string | null
  batch_id?: number | null
  batch_number?: string | null
  movement_type: string
  quantity: number
  unit_cost?: number | null
  reference_type: string
  reference_id?: number | null
  reason?: string | null
  created_at?: string | null
}

export type StockCountSummary = {
  id: number
  count_type: string
  status: string
  count_date?: string | null
  created_at?: string | null
}

export type StockCountCreatePayload = {
  count_type: 'daily' | 'monthly'
  count_date: string
  notes?: string | null
  items: Array<{
    product_id: number
    batch_id: number | null
    counted_quantity: number
    adjustment_reason?: string | null
    notes?: string | null
  }>
}

export type PurchaseDraftItemPayload = {
  product_id?: number | null
  product_name?: string | null
  unit?: string | null
  category_id?: number | null
  min_stock?: number
  is_weighted?: boolean
  track_expiry?: boolean
  track_batch?: boolean
  quantity: number
  purchase_price: number
  selling_price: number | null
  expiry_date: string | null
  batch_number: string | null
  notes?: string | null
}

export type PurchaseCreatePayload = {
  supplier_id: number
  invoice_number: string
  purchase_date: string
  discount_amount: number
  notes?: string | null
  items: PurchaseDraftItemPayload[]
}

export type PurchaseItem = {
  id: number
  product_id: number
  product_name?: string | null
  unit?: string | null
  is_sellable?: boolean | null
  quantity: number
  purchase_price: number
  selling_price?: number | null
  line_total: number
  expiry_date?: string | null
  batch_number?: string | null
  notes?: string | null
}

export type PurchaseSummary = {
  id: number
  supplier_id: number
  invoice_number: string
  purchase_date?: string | null
  status: 'draft' | 'confirmed' | 'cancelled' | string
  subtotal: number
  discount_amount: number
  total_amount: number
}

export type PurchaseDetail = PurchaseSummary & {
  supplier_name?: string | null
  notes?: string | null
  created_by?: number
  confirmed_by?: number | null
  confirmed_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  items: PurchaseItem[]
}

export type SupplierPurchaseSummary = {
  id: number
  invoice_number: string
  purchase_date?: string | null
  status: string
  total_amount: number
}

export type ReturnHistoryItem = {
  id: number
  invoice_item_id: number
  product_id: number
  product_name?: string | null
  quantity: number
  price: number
  subtotal: number
}

export type ReturnHistory = {
  id: number
  original_invoice_id: number
  cashier_id: number
  total_refunded: number
  reason?: string | null
  refund_method: string
  created_at?: string | null
  items: ReturnHistoryItem[]
}

export type ReturnCreatePayload = {
  invoice_id: number
  reason?: string | null
  refund_method: 'cash' | 'card' | 'digital'
  items: Array<{
    invoice_item_id: number
    quantity: number
  }>
}

export type ReportsDaily = {
  date: string
  gross_sales: number
  total_sales: number
  paid_total: number
  unpaid_total: number
  returned_total: number
  invoice_count: number
  average: number
}

export type ReportsReturnsSummary = {
  day: {
    total_refunded: number
    return_count: number
    items_count: number
  }
  month: {
    total_refunded: number
    return_count: number
    items_count: number
  }
}

export type ReportsCashierRow = {
  id: number
  name: string
  username: string
  cashier_number?: string | null
  role: UserRole
  day: {
    date: string
    count: number
    total: number
  }
  month: {
    month: string
    count: number
    total: number
  }
}

export type SalesInsightItem = {
  product_id: number
  name: string
  barcode: string
  qty_sold: number
  revenue: number
}

export type ReportsSalesInsights = {
  day: {
    date: string
    total_revenue: number
    top: SalesInsightItem[]
    bottom: SalesInsightItem[]
  }
  month: {
    month: string
    total_revenue: number
    top: SalesInsightItem[]
    bottom: SalesInsightItem[]
  }
}

export type AttendanceStatusRow = {
  id: number
  name: string
  username: string
  role: UserRole
  status: 'online' | 'offline' | string
  last_seen?: string | null
}

export type AttendancePeriod = {
  connected_at?: string | null
  disconnected_at?: string | null
  hours: number
}

export type AttendanceDay = {
  day: number
  date: string
  hours: number
  sessions_count: number
  is_abnormal: boolean
  first_connected?: string | null
  last_disconnected?: string | null
  periods: AttendancePeriod[]
}

export type AttendanceMonthlyEmployee = {
  id: number
  name: string
  username: string
  role: UserRole
  daily: AttendanceDay[]
  total_monthly_hours: number
  workday_hours_target?: number
}

export type ExpiryItem = {
  id: number
  barcode: string
  name: string
  stock: number
  expiry_date?: string | null
  days_left: number
  status: 'expired' | 'expires_today' | 'critical' | 'warning' | string
}

export type ExpiryReport = {
  threshold_days: number
  total: number
  expired: number
  critical: number
  warning: number
  items: ExpiryItem[]
}

export type ProductAlertsReport = {
  counts: {
    out_of_stock: number
    low_stock: number
    expired: number
    near_expiry: number
  }
  details: {
    out_of_stock: Array<{
      id: number
      name: string
      barcode: string
      stock: number
    }>
    low_stock: Array<{
      id: number
      name: string
      barcode: string
      stock: number
      min: number
    }>
    expired: Array<{
      id: number
      name: string
      barcode: string
      expiry: string
    }>
    near_expiry: Array<{
      id: number
      name: string
      barcode: string
      expiry: string
    }>
  }
}

export type ReportsDashboardPeriod = {
  preset: 'today' | 'week' | 'month' | 'custom' | string
  date_from: string
  date_to: string
  label: string
  day_count: number
}

export type ReportsDashboardKpis = {
  gross_sales: number
  net_sales: number
  total_returns: number
  return_count: number
  invoice_count: number
  average_invoice_value: number
  low_stock_products_count: number
  near_expiry_products_count: number
  estimated_inventory_margin?: number | null
  top_selling_product_name?: string | null
  top_selling_product_qty?: number | null
}

export type ReportsDashboardTimeSeriesPoint = {
  key: string
  label: string
  gross_sales: number
  net_sales: number
  returns: number
}

export type ReportsDashboardProductPoint = {
  product_id: number
  name: string
  barcode?: string | null
  category_name?: string | null
  sold_qty: number
  returned_qty: number
  net_qty: number
  gross_revenue: number
  returned_revenue: number
  net_revenue: number
  stock?: number | null
  min_stock?: number | null
}

export type ReportsDashboardCategoryPoint = {
  category_id?: number | null
  category_name: string
  sold_qty: number
  returned_qty: number
  net_qty: number
  gross_revenue: number
  returned_revenue: number
  net_revenue: number
}

export type ReportsDashboardHourlyPoint = {
  hour: number
  label: string
  invoices: number
  gross_sales: number
}

export type ReportsDashboardPaymentMethodPoint = {
  payment_method: string
  label: string
  count: number
  amount: number
}

export type ReportsDashboardAlertItem = {
  id: number
  name: string
  barcode?: string | null
  stock?: number | null
  min_stock?: number | null
  expiry_date?: string | null
  days_left?: number | null
  status: string
}

export type ReportsDashboardInsight = {
  id: string
  type: string
  tone: 'positive' | 'warning' | 'info' | string
  title: string
  body: string
  basis: string
}

export type ReportsDashboardResponse = {
  period: ReportsDashboardPeriod
  kpis: ReportsDashboardKpis
  series: {
    sales_over_time: ReportsDashboardTimeSeriesPoint[]
    returns_vs_sales: ReportsDashboardTimeSeriesPoint[]
    top_products: ReportsDashboardProductPoint[]
    category_performance: ReportsDashboardCategoryPoint[]
    hourly_sales: ReportsDashboardHourlyPoint[]
    payment_methods: ReportsDashboardPaymentMethodPoint[]
  }
  insights: ReportsDashboardInsight[]
  alerts: {
    low_stock_count: number
    out_of_stock_count: number
    near_expiry_count: number
    low_stock: ReportsDashboardAlertItem[]
    near_expiry: ReportsDashboardAlertItem[]
  }
  tables: {
    top_products: ReportsDashboardProductPoint[]
    category_performance: ReportsDashboardCategoryPoint[]
    payment_methods: ReportsDashboardPaymentMethodPoint[]
  }
}
