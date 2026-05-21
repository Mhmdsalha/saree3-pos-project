import { useEffect, useRef, useState } from 'react'
import { clearStoredSession, type StoredSession } from '@/lib/auth'
import { publishNotice } from '@/lib/notice-center'
import { clearMobileSessionBackup } from '@/mobile/session-utils'
import {
  clearIntervalRef,
  clearTimerRef,
  payloadMatchesSession,
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  WS_WATCHDOG_INTERVAL_MS,
} from '@/lib/ws-session'
import type { CustomerTelegramStatus, Product } from '@/types/api'

type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
type NoticeKind = 'accepted' | 'duplicate'
const MAX_LOCAL_SERVER_RECONNECT_FAILURES = 5

type UseMobileSocketOptions = {
  session: StoredSession | null
  flushPendingBarcodes: () => void
  showNotice: (kind: NoticeKind, text: string, duration?: number) => void
  onProductFound: (product: Product, scanId?: string | null) => void
  onProductNotFound: (barcode: string, scanId?: string | null) => void
  onCustomerActivationOpen: (customer: CustomerTelegramStatus) => void
  onCustomerTelegramStatus: (customer: CustomerTelegramStatus) => void
  onScanAcknowledged: (scanId?: string | null) => void
  onSessionExpired: () => void
}

export function useMobileSocket({
  session,
  flushPendingBarcodes,
  showNotice,
  onProductFound,
  onProductNotFound,
  onCustomerActivationOpen,
  onCustomerTelegramStatus,
  onScanAcknowledged,
  onSessionExpired,
}: UseMobileSocketOptions) {
  const [connection, setConnection] = useState<ConnectionState>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const heartbeatRef = useRef<number | null>(null)
  const watchdogRef = useRef<number | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectFailuresRef = useRef(0)
  const connectRef = useRef<(() => void) | null>(null)
  const lastSocketActivityRef = useRef<number>(Date.now())
  const flushPendingBarcodesRef = useRef(flushPendingBarcodes)
  const showNoticeRef = useRef(showNotice)
  const onProductFoundRef = useRef(onProductFound)
  const onProductNotFoundRef = useRef(onProductNotFound)
  const onCustomerActivationOpenRef = useRef(onCustomerActivationOpen)
  const onCustomerTelegramStatusRef = useRef(onCustomerTelegramStatus)
  const onScanAcknowledgedRef = useRef(onScanAcknowledged)
  const onSessionExpiredRef = useRef(onSessionExpired)

  useEffect(() => {
    flushPendingBarcodesRef.current = flushPendingBarcodes
    showNoticeRef.current = showNotice
    onProductFoundRef.current = onProductFound
    onProductNotFoundRef.current = onProductNotFound
    onCustomerActivationOpenRef.current = onCustomerActivationOpen
    onCustomerTelegramStatusRef.current = onCustomerTelegramStatus
    onScanAcknowledgedRef.current = onScanAcknowledged
    onSessionExpiredRef.current = onSessionExpired
  }, [
    flushPendingBarcodes,
    onCustomerActivationOpen,
    onCustomerTelegramStatus,
    onScanAcknowledged,
    onProductFound,
    onProductNotFound,
    onSessionExpired,
    showNotice,
  ])

  useEffect(() => {
    if (!session?.sessionToken || !session.serverUrl) return
    let cancelled = false
    const sessionToken = session.sessionToken
    const serverUrl = session.serverUrl
    reconnectFailuresRef.current = 0

    const cleanup = () => {
      clearIntervalRef(heartbeatRef)
      clearIntervalRef(watchdogRef)
      clearTimerRef(reconnectTimerRef)
      if (wsRef.current) {
        wsRef.current.onopen = null
        wsRef.current.onclose = null
        wsRef.current.onmessage = null
        try {
          wsRef.current.close()
        } catch {
          // ignore
        }
        wsRef.current = null
      }
    }

    const expireMobileSessionForNetworkChange = () => {
      cleanup()
      setConnection('disconnected')
      clearStoredSession()
      clearMobileSessionBackup()
      onSessionExpiredRef.current()
      publishNotice(
        'تعذر الوصول إلى السيرفر المحلي. إذا تغيّر عنوان الشبكة، أعد مسح QR من شاشة الكاشير.',
        'warning',
      )
    }

    const connect = () => {
      if (cancelled) return
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        return
      }

      setConnection((current) => (current === 'connected' ? 'reconnecting' : 'connecting'))

      const wsOrigin = serverUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
      const ws = new WebSocket(`${wsOrigin}/ws/${sessionToken}`)
      wsRef.current = ws

      ws.onopen = () => {
        if (wsRef.current !== ws) {
          try {
            ws.close()
          } catch {
            // ignore
          }
          return
        }
        lastSocketActivityRef.current = Date.now()
        reconnectFailuresRef.current = 0
        setConnection('connected')
        ws.send(JSON.stringify({ type: 'mobile_ready', session: sessionToken }))
        flushPendingBarcodesRef.current()
        clearTimerRef(reconnectTimerRef)
        clearIntervalRef(heartbeatRef)
        heartbeatRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, WS_PING_INTERVAL_MS)
        clearIntervalRef(watchdogRef)
        watchdogRef.current = window.setInterval(() => {
          if (document.hidden || wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return
          if (Date.now() - lastSocketActivityRef.current <= WS_PONG_TIMEOUT_MS) return
          try {
            ws.close()
          } catch {
            // ignore
          }
        }, WS_WATCHDOG_INTERVAL_MS)
      }

      ws.onclose = (event) => {
        if (wsRef.current !== ws) return
        wsRef.current = null
        setConnection('disconnected')
        clearIntervalRef(heartbeatRef)
        clearIntervalRef(watchdogRef)
        if (cancelled) return

        if (event.code === 4001) {
          clearStoredSession()
          clearMobileSessionBackup()
          onSessionExpiredRef.current()
          publishNotice('انتهت جلسة ربط الموبايل الحالية. أعد مسح QR من شاشة الكاشير.', 'error')
          return
        }

        reconnectFailuresRef.current += 1
        if (reconnectFailuresRef.current >= MAX_LOCAL_SERVER_RECONNECT_FAILURES) {
          expireMobileSessionForNetworkChange()
          return
        }

        setConnection('reconnecting')
        reconnectTimerRef.current = window.setTimeout(connect, 1_500)
      }

      ws.onerror = () => {
        if (wsRef.current !== ws) return
        setConnection('reconnecting')
      }

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return
        lastSocketActivityRef.current = Date.now()
        try {
          const payload = JSON.parse(event.data) as Record<string, unknown>
          if (!payloadMatchesSession(payload, sessionToken)) return
          if (payload.type === 'product_found' && payload.product && typeof payload.product === 'object') {
            onProductFoundRef.current(payload.product as Product, typeof payload.scan_id === 'string' ? payload.scan_id : null)
            showNoticeRef.current('accepted', 'تمت إضافة المنتج بنجاح')
            navigator.vibrate?.(40)
          } else if (payload.type === 'product_not_found' && typeof payload.barcode === 'string') {
            onProductNotFoundRef.current(payload.barcode, typeof payload.scan_id === 'string' ? payload.scan_id : null)
          } else if (payload.type === 'customer_activation_open' && payload.customer && typeof payload.customer === 'object') {
            onCustomerActivationOpenRef.current(payload.customer as CustomerTelegramStatus)
          } else if (payload.type === 'customer_telegram_status' && payload.customer && typeof payload.customer === 'object') {
            onCustomerTelegramStatusRef.current(payload.customer as CustomerTelegramStatus)
          } else if (payload.type === 'desktop_ready' || payload.type === 'mobile_ready_ack' || payload.type === 'pong') {
            setConnection('connected')
            flushPendingBarcodesRef.current()
          } else if (payload.type === 'duplicate_scan_ignored') {
            const scanId = typeof payload.scan_id === 'string' ? payload.scan_id : null
            if (scanId) {
              onScanAcknowledgedRef.current(scanId)
              showNoticeRef.current('duplicate', 'تم تجاهل سكان مكرر محفوظ سابقًا')
            }
          }
        } catch {
          // ignore malformed messages
        }
      }
    }

    connectRef.current = connect

    const reconnectOnVisible = () => {
      if (!document.hidden && (!wsRef.current || wsRef.current.readyState > WebSocket.OPEN)) {
        connect()
      }
    }

    const reconnectOnOnline = () => {
      if (!wsRef.current || wsRef.current.readyState > WebSocket.OPEN) {
        connect()
      }
    }

    document.addEventListener('visibilitychange', reconnectOnVisible)
    window.addEventListener('online', reconnectOnOnline)
    connect()

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', reconnectOnVisible)
      window.removeEventListener('online', reconnectOnOnline)
      connectRef.current = null
      cleanup()
    }
  }, [session?.serverUrl, session?.sessionToken])

  return {
    connection,
    wsRef,
    connectNow: () => connectRef.current?.(),
  }
}
