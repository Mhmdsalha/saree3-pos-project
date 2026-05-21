import type { InvoiceCreatePayload, Product, User } from '@/types/api'

const DB_NAME = 'flowpos-offline'
const DB_VERSION = 1

const STORE_PRODUCT_CACHE = 'cashier_products'
const STORE_OFFLINE_INVOICES = 'offline_invoices'
const STORE_MOBILE_SCANS = 'mobile_scans'

type OfflineInvoiceStatus = 'pending' | 'syncing' | 'failed'
type MobileScanStatus = 'pending' | 'sending'

export type CachedSellableProductsRecord = {
  cacheKey: string
  serverUrl: string
  fetchedAt: string
  products: Product[]
}

export type OfflineInvoicePayload = InvoiceCreatePayload & {
  offline_uuid: string
}

export type OfflineInvoiceRecord = {
  localId: string
  offlineUuid: string
  sessionScope: string
  serverUrl: string
  sessionToken: string
  cashierId: number | null
  cashierName: string | null
  createdAt: string
  updatedAt: string
  status: OfflineInvoiceStatus
  retryCount: number
  lastError: string | null
  payload: OfflineInvoicePayload
  summary: {
    customerName: string | null
    customerPhone: string | null
    paymentMethod: InvoiceCreatePayload['payment_method']
    subtotal: number
    discount: number
    total: number
    totalQty: number
    items?: Array<{
      productId: number
      name: string | null
      quantity: number
      price: number
      lineTotal: number
      unit?: string | null
    }>
  }
}

export type MobileQueuedScanRecord = {
  scanId: string
  sessionScope: string
  serverUrl: string
  sessionToken: string
  barcode: string
  createdAt: string
  updatedAt: string
  status: MobileScanStatus
  attempts: number
  lastError: string | null
  userId: number | null
  userName: string | null
}

function openOfflineDb() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB غير متاحة على هذا المتصفح.'))
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(STORE_PRODUCT_CACHE)) {
        db.createObjectStore(STORE_PRODUCT_CACHE, { keyPath: 'cacheKey' })
      }

      if (!db.objectStoreNames.contains(STORE_OFFLINE_INVOICES)) {
        const store = db.createObjectStore(STORE_OFFLINE_INVOICES, { keyPath: 'localId' })
        store.createIndex('by_session_scope', 'sessionScope', { unique: false })
        store.createIndex('by_status', 'status', { unique: false })
        store.createIndex('by_created_at', 'createdAt', { unique: false })
      }

      if (!db.objectStoreNames.contains(STORE_MOBILE_SCANS)) {
        const store = db.createObjectStore(STORE_MOBILE_SCANS, { keyPath: 'scanId' })
        store.createIndex('by_session_scope', 'sessionScope', { unique: false })
        store.createIndex('by_status', 'status', { unique: false })
        store.createIndex('by_created_at', 'createdAt', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('تعذر فتح قاعدة بيانات الأوفلاين.'))
  })
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('فشل تنفيذ العملية على IndexedDB.'))
  })
}

function waitForTransaction(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('تم إلغاء معاملة IndexedDB.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('فشلت معاملة IndexedDB.'))
  })
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore, transaction: IDBTransaction) => Promise<T> | T,
) {
  const db = await openOfflineDb()
  try {
    const transaction = db.transaction(storeName, mode)
    const store = transaction.objectStore(storeName)
    const result = await callback(store, transaction)
    if (mode !== 'readonly') {
      await waitForTransaction(transaction)
    }
    return result
  } finally {
    db.close()
  }
}

async function getAllFromIndex<T>(store: IDBObjectStore, indexName: string, key: IDBValidKey) {
  const index = store.index(indexName)
  return (await requestToPromise(index.getAll(key))) as T[]
}

function createUuid(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function buildSessionScope(serverUrl: string, sessionToken: string) {
  return `${serverUrl}::${sessionToken}`
}

export function buildCashierOfflineScope(serverUrl: string, userId: number | null | undefined) {
  return `${serverUrl}::cashier::${userId ?? 0}`
}

export function createOfflineInvoiceId() {
  return createUuid('offline-invoice')
}

export function createOfflineInvoiceUuid() {
  return createUuid('invoice')
}

export function createMobileScanId() {
  return createUuid('scan')
}

export async function saveCachedSellableProducts(serverUrl: string, products: Product[]) {
  const record: CachedSellableProductsRecord = {
    cacheKey: `${serverUrl}::sellable`,
    serverUrl,
    fetchedAt: new Date().toISOString(),
    products,
  }

  await withStore(STORE_PRODUCT_CACHE, 'readwrite', async (store) => {
    await requestToPromise(store.put(record))
  })

  return record
}

export async function loadCachedSellableProducts(serverUrl: string) {
  return withStore(STORE_PRODUCT_CACHE, 'readonly', async (store) => {
    return (await requestToPromise(store.get(`${serverUrl}::sellable`))) as CachedSellableProductsRecord | undefined
  })
}

export async function upsertOfflineInvoice(record: OfflineInvoiceRecord) {
  await withStore(STORE_OFFLINE_INVOICES, 'readwrite', async (store) => {
    await requestToPromise(store.put(record))
  })
  return record
}

export async function listOfflineInvoicesBySession(sessionScope: string) {
  return withStore(STORE_OFFLINE_INVOICES, 'readonly', async (store) => {
    const items = await getAllFromIndex<OfflineInvoiceRecord>(store, 'by_session_scope', sessionScope)
    return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  })
}

export async function removeOfflineInvoice(localId: string) {
  await withStore(STORE_OFFLINE_INVOICES, 'readwrite', async (store) => {
    await requestToPromise(store.delete(localId))
  })
}

export async function markOfflineInvoiceStatus(localId: string, status: OfflineInvoiceStatus, lastError?: string | null) {
  await withStore(STORE_OFFLINE_INVOICES, 'readwrite', async (store) => {
    const current = (await requestToPromise(store.get(localId))) as OfflineInvoiceRecord | undefined
    if (!current) return

    const nextRecord: OfflineInvoiceRecord = {
      ...current,
      status,
      lastError: typeof lastError === 'string' ? lastError : current.lastError,
      updatedAt: new Date().toISOString(),
      retryCount: status === 'failed' ? current.retryCount + 1 : current.retryCount,
    }
    await requestToPromise(store.put(nextRecord))
  })
}

export async function resetSyncingOfflineInvoices(sessionScope: string) {
  await withStore(STORE_OFFLINE_INVOICES, 'readwrite', async (store) => {
    const items = await getAllFromIndex<OfflineInvoiceRecord>(store, 'by_session_scope', sessionScope)
    for (const item of items) {
      if (item.status !== 'syncing') continue
      await requestToPromise(
        store.put({
          ...item,
          status: 'pending',
          updatedAt: new Date().toISOString(),
        } satisfies OfflineInvoiceRecord),
      )
    }
  })
}

export async function enqueueMobileScan(record: MobileQueuedScanRecord) {
  await withStore(STORE_MOBILE_SCANS, 'readwrite', async (store) => {
    await requestToPromise(store.put(record))
  })
  return record
}

export async function listMobileScansBySession(sessionScope: string) {
  return withStore(STORE_MOBILE_SCANS, 'readonly', async (store) => {
    const items = await getAllFromIndex<MobileQueuedScanRecord>(store, 'by_session_scope', sessionScope)
    return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  })
}

export async function getNextPendingMobileScan(sessionScope: string) {
  const items = await listMobileScansBySession(sessionScope)
  return items.find((item) => item.status === 'pending') ?? null
}

export async function markMobileScanSending(scanId: string) {
  await withStore(STORE_MOBILE_SCANS, 'readwrite', async (store) => {
    const current = (await requestToPromise(store.get(scanId))) as MobileQueuedScanRecord | undefined
    if (!current) return
    await requestToPromise(
      store.put({
        ...current,
        status: 'sending',
        updatedAt: new Date().toISOString(),
        attempts: current.attempts + 1,
      } satisfies MobileQueuedScanRecord),
    )
  })
}

export async function resetSendingMobileScans(sessionScope: string) {
  await withStore(STORE_MOBILE_SCANS, 'readwrite', async (store) => {
    const items = await getAllFromIndex<MobileQueuedScanRecord>(store, 'by_session_scope', sessionScope)
    for (const item of items) {
      if (item.status !== 'sending') continue
      await requestToPromise(
        store.put({
          ...item,
          status: 'pending',
          updatedAt: new Date().toISOString(),
        } satisfies MobileQueuedScanRecord),
      )
    }
  })
}

export async function updateMobileScanError(scanId: string, message: string | null) {
  await withStore(STORE_MOBILE_SCANS, 'readwrite', async (store) => {
    const current = (await requestToPromise(store.get(scanId))) as MobileQueuedScanRecord | undefined
    if (!current) return
    await requestToPromise(
      store.put({
        ...current,
        status: 'pending',
        updatedAt: new Date().toISOString(),
        lastError: message,
      } satisfies MobileQueuedScanRecord),
    )
  })
}

export async function removeMobileScan(scanId: string) {
  await withStore(STORE_MOBILE_SCANS, 'readwrite', async (store) => {
    await requestToPromise(store.delete(scanId))
  })
}

export async function restoreMobileSessionFromPendingScans() {
  const items = await withStore(STORE_MOBILE_SCANS, 'readonly', async (store) => {
    return (await requestToPromise(store.getAll())) as MobileQueuedScanRecord[]
  })

  const latest = [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  if (!latest) return null

  return {
    serverUrl: latest.serverUrl,
    sessionToken: latest.sessionToken,
    user: {
      id: latest.userId ?? 0,
      username: 'mobile-offline',
      name: latest.userName || 'الموبايل',
      role: 'cashier' as User['role'],
      cashier_number: null,
      phone: null,
      is_active: true,
    },
  }
}
