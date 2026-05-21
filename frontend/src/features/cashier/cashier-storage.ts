import { getStoredSessionSnapshot } from '@/lib/auth'
import type { CashierDraftStorage, CashierHeldStorage, CashierStorageMeta, HeldInvoice, InvoiceItem } from '@/features/cashier/cashier-types'

const DRAFT_KEY = 'pos_draft_invoice'
const HELD_KEY = 'pos_held_invoices'
const PROCESSED_SCAN_KEY = 'pos_processed_mobile_scans'
const MAX_PROCESSED_SCAN_RECEIPTS = 200
const PROCESSED_SCAN_TTL_MS = 1000 * 60 * 60 * 24

export function nextLineId() {
  return Date.now() + Math.floor(Math.random() * 1000)
}

export function scopedCashierStorageKeys() {
  const sessionToken = getStoredSessionSnapshot()?.sessionToken
  return {
    draft: sessionToken ? `${DRAFT_KEY}:${sessionToken}` : DRAFT_KEY,
    held: sessionToken ? `${HELD_KEY}:${sessionToken}` : HELD_KEY,
    processedScans: sessionToken ? `${PROCESSED_SCAN_KEY}:${sessionToken}` : PROCESSED_SCAN_KEY,
  }
}

export function migrateCashierStorageKeys(keys: { draft: string; held: string; processedScans: string }) {
  if (keys.draft !== DRAFT_KEY && !window.localStorage.getItem(keys.draft)) {
    const legacyDraft = window.localStorage.getItem(DRAFT_KEY)
    if (legacyDraft) {
      window.localStorage.setItem(keys.draft, legacyDraft)
      window.localStorage.removeItem(DRAFT_KEY)
    }
  }

  if (keys.held !== HELD_KEY && !window.localStorage.getItem(keys.held)) {
    const legacyHeld = window.localStorage.getItem(HELD_KEY)
    if (legacyHeld) {
      window.localStorage.setItem(keys.held, legacyHeld)
      window.localStorage.removeItem(HELD_KEY)
    }
  }
}

type ProcessedScanReceipt = {
  scanId: string
  processedAt: string
}

function normalizeProcessedScanReceipts(items: ProcessedScanReceipt[]) {
  const now = Date.now()
  return items
    .filter((item) => item?.scanId && item?.processedAt)
    .filter((item) => now - new Date(item.processedAt).getTime() <= PROCESSED_SCAN_TTL_MS)
    .sort((left, right) => right.processedAt.localeCompare(left.processedAt))
    .slice(0, MAX_PROCESSED_SCAN_RECEIPTS)
}

export function hasProcessedScanReceipt(storageKey: string, scanId: string) {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return false
    const parsed = normalizeProcessedScanReceipts(JSON.parse(raw) as ProcessedScanReceipt[])
    return parsed.some((item) => item.scanId === scanId)
  } catch {
    return false
  }
}

export function rememberProcessedScanReceipt(storageKey: string, scanId: string) {
  const existing = (() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (!raw) return [] as ProcessedScanReceipt[]
      return normalizeProcessedScanReceipts(JSON.parse(raw) as ProcessedScanReceipt[])
    } catch {
      return [] as ProcessedScanReceipt[]
    }
  })()

  const next = normalizeProcessedScanReceipts([
    { scanId, processedAt: new Date().toISOString() },
    ...existing.filter((item) => item.scanId !== scanId),
  ])
  window.localStorage.setItem(storageKey, JSON.stringify(next))
}

export function normalizeInvoiceItems(items: InvoiceItem[] | undefined) {
  return (items || []).map((item) => ({
    ...item,
    lineId: item.lineId || nextLineId(),
  }))
}

export function loadHeldInvoices(storageKey: string): HeldInvoice[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || '[]') as HeldInvoice[] | CashierHeldStorage
    const items = Array.isArray(parsed) ? parsed : parsed.items || []
    return items.map((entry) => ({
      ...entry,
      items: normalizeInvoiceItems(entry.items),
    }))
  } catch {
    return []
  }
}

export function loadHeldStorageMeta(storageKey: string): CashierStorageMeta | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || 'null') as HeldInvoice[] | CashierHeldStorage | null
    if (!parsed || Array.isArray(parsed)) return null
    return parsed.meta || null
  } catch {
    return null
  }
}

export function saveHeldInvoices(storageKey: string, items: HeldInvoice[], sourceId: string) {
  const payload: CashierHeldStorage = {
    items,
    meta: {
      sourceId,
      updatedAt: new Date().toISOString(),
    },
  }
  window.localStorage.setItem(storageKey, JSON.stringify(payload))
}

export function loadDraftInvoice(storageKey: string) {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    return JSON.parse(raw) as CashierDraftStorage
  } catch {
    return null
  }
}
