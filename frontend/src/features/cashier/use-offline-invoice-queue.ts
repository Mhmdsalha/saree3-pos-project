import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StoredSession } from '@/lib/auth'
import {
  buildCashierOfflineScope,
  createOfflineInvoiceId,
  createOfflineInvoiceUuid,
  listOfflineInvoicesBySession,
  markOfflineInvoiceStatus,
  removeOfflineInvoice,
  resetSyncingOfflineInvoices,
  type OfflineInvoicePayload,
  type OfflineInvoiceRecord,
  upsertOfflineInvoice,
} from '@/lib/offline-db'
import { apiRequest } from '@/lib/api-client'
import type { CashierConnectionState, CashierSyncState, PaymentMethod } from '@/features/cashier/cashier-types'
import type { InvoiceCreatePayload } from '@/types/api'

type QueueInvoiceInput = {
  payload: InvoiceCreatePayload
  summary: {
    customerName: string | null
    customerPhone: string | null
    paymentMethod: PaymentMethod
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

type SyncInvoiceResponse = Array<{
  status: 'ok' | 'error'
  offline_uuid?: string | null
  id?: number
  detail?: string
}>

function isLikelyNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase()
  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('load failed') ||
    message.includes('network request failed') ||
    message.includes('fetch failed')
  )
}

async function pingServer(serverUrl: string) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 4_000)
  try {
    const response = await fetch(`${serverUrl}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}

export function useOfflineInvoiceQueue(session: StoredSession | null) {
  const [connectionState, setConnectionState] = useState<CashierConnectionState>('reconnecting')
  const [syncState, setSyncState] = useState<CashierSyncState>('idle')
  const [pendingInvoices, setPendingInvoices] = useState<OfflineInvoiceRecord[]>([])
  const [lastSyncError, setLastSyncError] = useState<string | null>(null)
  const syncingRef = useRef(false)
  const healthTimerRef = useRef<number | null>(null)
  const sessionScope = useMemo(
    () => (session?.serverUrl ? buildCashierOfflineScope(session.serverUrl, session.user.id) : null),
    [session?.serverUrl, session?.user.id],
  )

  const loadPendingInvoices = useCallback(async () => {
    if (!sessionScope) {
      setPendingInvoices([])
      return []
    }
    const items = await listOfflineInvoicesBySession(sessionScope)
    setPendingInvoices(items)
    return items
  }, [sessionScope])

  const refreshConnection = useCallback(async () => {
    if (!session?.serverUrl) {
      setConnectionState('offline')
      return false
    }
    if (!window.navigator.onLine) {
      setConnectionState('offline')
      return false
    }
    setConnectionState((current) => (current === 'online' ? current : 'reconnecting'))
    const reachable = await pingServer(session.serverUrl)
    setConnectionState(reachable ? 'online' : 'offline')
    return reachable
  }, [session?.serverUrl])

  const markOffline = useCallback(() => {
    setConnectionState('offline')
  }, [])

  const syncInvoiceRecords = useCallback(async (queued: OfflineInvoiceRecord[]) => {
    if (!sessionScope || !session) return { synced: 0, failed: 0 }
    if (syncingRef.current) return { synced: 0, failed: 0 }
    if (!queued.length) {
      setSyncState('idle')
      setLastSyncError(null)
      return { synced: 0, failed: 0 }
    }

    syncingRef.current = true
    setSyncState('syncing')
    setLastSyncError(null)

    try {
      for (const item of queued) {
        await markOfflineInvoiceStatus(item.localId, 'syncing', null)
      }

      const results = await apiRequest<SyncInvoiceResponse>('/invoices/sync', {
        method: 'POST',
        body: JSON.stringify(queued.map((item) => item.payload)),
      })

      let synced = 0
      let failed = 0

      for (const item of queued) {
        const match = results.find((entry) => entry.offline_uuid === item.offlineUuid)
        if (match?.status === 'ok') {
          await removeOfflineInvoice(item.localId)
          synced += 1
        } else {
          failed += 1
          await markOfflineInvoiceStatus(item.localId, 'failed', match?.detail || 'تعذر مزامنة الفاتورة.')
        }
      }

      await loadPendingInvoices()
      setSyncState(failed ? 'failed' : synced ? 'success' : 'idle')
      setLastSyncError(failed ? 'بعض الفواتير لم تتم مزامنتها بعد.' : null)
      return { synced, failed }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذر مزامنة الفواتير.'
      const fallbackStatus = isLikelyNetworkError(error) ? 'pending' : 'failed'

      for (const item of queued) {
        await markOfflineInvoiceStatus(item.localId, fallbackStatus, message)
      }

      await loadPendingInvoices()
      if (isLikelyNetworkError(error)) {
        setConnectionState('offline')
      }
      setSyncState('failed')
      setLastSyncError(message)
      return { synced: 0, failed: queued.length }
    } finally {
      syncingRef.current = false
    }
  }, [loadPendingInvoices, session, sessionScope])

  const syncPendingInvoices = useCallback(async () => {
    if (!sessionScope || !session) return { synced: 0, failed: 0 }
    if (syncingRef.current) return { synced: 0, failed: 0 }

    const queued = (await loadPendingInvoices()).filter((item) => item.status === 'pending' || item.status === 'failed')
    if (!queued.length) {
      setSyncState('idle')
      setLastSyncError(null)
      return { synced: 0, failed: 0 }
    }

    const reachable = await refreshConnection()
    if (!reachable) {
      return { synced: 0, failed: queued.length }
    }

    return syncInvoiceRecords(queued)
  }, [loadPendingInvoices, refreshConnection, session, sessionScope, syncInvoiceRecords])

  const syncPendingInvoice = useCallback(async (localId: string) => {
    if (!localId || !sessionScope || !session) return { synced: 0, failed: 0 }
    if (syncingRef.current) return { synced: 0, failed: 0 }

    const target = (await loadPendingInvoices()).find((item) => item.localId === localId)
    if (!target || (target.status !== 'pending' && target.status !== 'failed')) {
      return { synced: 0, failed: 0 }
    }

    const reachable = await refreshConnection()
    if (!reachable) {
      return { synced: 0, failed: 1 }
    }

    return syncInvoiceRecords([target])
  }, [loadPendingInvoices, refreshConnection, session, sessionScope, syncInvoiceRecords])

  const removePendingInvoice = useCallback(async (localId: string) => {
    if (!localId) return false
    await removeOfflineInvoice(localId)
    const remaining = await loadPendingInvoices()
    if (!remaining.some((item) => item.status === 'failed')) {
      setLastSyncError(null)
      setSyncState((current) => (current === 'syncing' ? current : 'idle'))
    }
    return true
  }, [loadPendingInvoices])

  const queueInvoice = useCallback(
    async ({ payload, summary }: QueueInvoiceInput) => {
      if (!session || !sessionScope) {
        throw new Error('تعذر حفظ الفاتورة محليًا بدون جلسة كاشير صالحة.')
      }

      const offlineUuid = payload.offline_uuid || createOfflineInvoiceUuid()
      const now = new Date().toISOString()
      const record: OfflineInvoiceRecord = {
        localId: createOfflineInvoiceId(),
        offlineUuid,
        sessionScope,
        serverUrl: session.serverUrl,
        sessionToken: session.sessionToken,
        cashierId: session.user.id ?? null,
        cashierName: session.user.name ?? null,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        retryCount: 0,
        lastError: null,
        payload: {
          ...payload,
          offline_uuid: offlineUuid,
        } satisfies OfflineInvoicePayload,
        summary,
      }

      await upsertOfflineInvoice(record)
      await loadPendingInvoices()
      return record
    },
    [loadPendingInvoices, session, sessionScope],
  )

  useEffect(() => {
    if (!sessionScope) return
    void resetSyncingOfflineInvoices(sessionScope).then(loadPendingInvoices)
  }, [loadPendingInvoices, sessionScope])

  useEffect(() => {
    if (!session?.serverUrl) return
    let cancelled = false
    const hasSyncCandidates = () =>
      pendingInvoices.some((item) => item.status === 'pending' || item.status === 'failed')

    const runHealthCheck = async () => {
      const reachable = await refreshConnection()
      if (!cancelled && reachable && hasSyncCandidates()) {
        void syncPendingInvoices()
      }
    }

    const handleOnline = () => {
      void runHealthCheck()
    }

    const handleOffline = () => {
      setConnectionState('offline')
    }

    const handleVisible = () => {
      if (!document.hidden) {
        void runHealthCheck()
      }
    }

    void runHealthCheck()
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    document.addEventListener('visibilitychange', handleVisible)
    healthTimerRef.current = window.setInterval(() => {
      if (!document.hidden) {
        void runHealthCheck()
      }
    }, 30_000)

    return () => {
      cancelled = true
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      document.removeEventListener('visibilitychange', handleVisible)
      if (healthTimerRef.current) {
        window.clearInterval(healthTimerRef.current)
        healthTimerRef.current = null
      }
    }
  }, [pendingInvoices, refreshConnection, session?.serverUrl, syncPendingInvoices])

  const pendingCount = pendingInvoices.filter((item) => item.status === 'pending' || item.status === 'syncing').length
  const failedCount = pendingInvoices.filter((item) => item.status === 'failed').length

  const estimatedStockDeltas = useMemo(() => {
    const deltas = new Map<number, number>()
    pendingInvoices
      .filter((item) => item.status === 'pending' || item.status === 'syncing')
      .forEach((invoice) => {
        invoice.payload.items.forEach((entry) => {
          deltas.set(entry.product_id, (deltas.get(entry.product_id) || 0) + Number(entry.quantity || 0))
        })
      })
    return deltas
  }, [pendingInvoices])

  return {
    connectionState,
    syncState,
    pendingInvoices,
    pendingCount,
    failedCount,
    lastSyncError,
    estimatedStockDeltas,
    queueInvoice,
    syncPendingInvoices,
    syncPendingInvoice,
    removePendingInvoice,
    refreshConnection,
    markOffline,
    isLikelyNetworkError,
  }
}
