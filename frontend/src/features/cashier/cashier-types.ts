export type PaymentMethod = 'cash' | 'card' | 'digital'
export type CashierConnectionState = 'online' | 'offline' | 'reconnecting'
export type CashierSyncState = 'idle' | 'syncing' | 'success' | 'failed'

export type InvoiceItem = {
  lineId: number
  id: number
  barcode?: string | null
  name: string
  price: number
  qty: number
  lineTotal?: number
  unit?: string | null
  is_weighted?: boolean
  is_manual_price?: boolean
}

export type HeldInvoice = {
  id: number
  heldAt: string
  customerName: string
  customerPhone: string
  payment: PaymentMethod
  discount: number
  items: InvoiceItem[]
}

export type CashierStorageMeta = {
  sourceId?: string
  updatedAt?: string
}

export type CashierHeldStorage = {
  items: HeldInvoice[]
  meta?: CashierStorageMeta
}

export type CashierDraftStorage = {
  invoice?: { items?: InvoiceItem[]; payment?: PaymentMethod; discount?: number }
  customerName?: string
  customerPhone?: string
  _meta?: CashierStorageMeta
}

export function paymentMethodLabel(method: PaymentMethod) {
  return ({ cash: 'نقدي', card: 'بطاقة', digital: 'رقمي' } as const)[method]
}
