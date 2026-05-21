import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StoredSession } from '@/lib/auth'
import {
  buildSessionScope,
  createMobileScanId,
  enqueueMobileScan,
  getNextPendingMobileScan,
  listMobileScansBySession,
  markMobileScanSending,
  removeMobileScan,
  resetSendingMobileScans,
  type MobileQueuedScanRecord,
} from '@/lib/offline-db'

type MobileConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

type UseMobileScanQueueOptions = {
  session: StoredSession | null
  connection: MobileConnectionState
  wsRef: React.MutableRefObject<WebSocket | null>
}

export function useMobileScanQueue({ session, connection, wsRef }: UseMobileScanQueueOptions) {
  const [pendingScanCount, setPendingScanCount] = useState(0)
  const [pendingScans, setPendingScans] = useState<MobileQueuedScanRecord[]>([])
  const [activeScanId, setActiveScanId] = useState<string | null>(null)
  const activeScanIdRef = useRef<string | null>(null)
  const sessionScope = useMemo(
    () => (session?.sessionToken ? buildSessionScope(session.serverUrl, session.sessionToken) : null),
    [session?.serverUrl, session?.sessionToken],
  )

  const refreshPendingState = useCallback(async () => {
    if (!sessionScope) {
      setPendingScans([])
      setPendingScanCount(0)
      return []
    }
    const items = await listMobileScansBySession(sessionScope)
    setPendingScans(items)
    setPendingScanCount(items.length)
    return items
  }, [sessionScope])

  const flushPendingScans = useCallback(async () => {
    if (!sessionScope || connection !== 'connected') return
    if (activeScanIdRef.current) return

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const nextScan = await getNextPendingMobileScan(sessionScope)
    if (!nextScan) {
      await refreshPendingState()
      return
    }

    await markMobileScanSending(nextScan.scanId)
    activeScanIdRef.current = nextScan.scanId
    setActiveScanId(nextScan.scanId)
    await refreshPendingState()
    ws.send(JSON.stringify({ type: 'scan_barcode', barcode: nextScan.barcode, scan_id: nextScan.scanId }))
  }, [connection, refreshPendingState, sessionScope, wsRef])

  const queueScan = useCallback(
    async (barcode: string) => {
      if (!session || !sessionScope) {
        throw new Error('تعذر حفظ السكان محليًا بدون جلسة جوال صالحة.')
      }

      const now = new Date().toISOString()
      const record: MobileQueuedScanRecord = {
        scanId: createMobileScanId(),
        sessionScope,
        serverUrl: session.serverUrl,
        sessionToken: session.sessionToken,
        barcode,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        attempts: 0,
        lastError: null,
        userId: session.user.id ?? null,
        userName: session.user.name ?? null,
      }
      await enqueueMobileScan(record)
      await refreshPendingState()
      await flushPendingScans()
      return record
    },
    [flushPendingScans, refreshPendingState, session, sessionScope],
  )

  const acknowledgeScan = useCallback(
    async (scanId?: string | null) => {
      if (!scanId) return
      await removeMobileScan(scanId)
      if (activeScanIdRef.current === scanId) {
        activeScanIdRef.current = null
        setActiveScanId(null)
      }
      await refreshPendingState()
      await flushPendingScans()
    },
    [flushPendingScans, refreshPendingState],
  )

  const removeQueuedScan = useCallback(
    async (scanId: string) => {
      if (!scanId) return
      await removeMobileScan(scanId)
      if (activeScanIdRef.current === scanId) {
        activeScanIdRef.current = null
        setActiveScanId(null)
      }
      await refreshPendingState()
      await flushPendingScans()
    },
    [flushPendingScans, refreshPendingState],
  )

  useEffect(() => {
    activeScanIdRef.current = activeScanId
  }, [activeScanId])

  useEffect(() => {
    if (!sessionScope) return
    void resetSendingMobileScans(sessionScope).then(refreshPendingState)
  }, [refreshPendingState, sessionScope])

  useEffect(() => {
    if (!sessionScope) return
    if (connection === 'connected') {
      void flushPendingScans()
      return
    }
    activeScanIdRef.current = null
    setActiveScanId(null)
    void resetSendingMobileScans(sessionScope).then(refreshPendingState)
  }, [connection, flushPendingScans, refreshPendingState, sessionScope])

  return {
    activeScanId,
    pendingScanCount,
    pendingScans,
    queueScan,
    acknowledgeScan,
    removeQueuedScan,
    flushPendingScans,
  }
}
