import { useEffect, useRef, useState } from 'react'
import { resolveWsOrigin } from '@/lib/api-client'
import { getStoredSessionSnapshot } from '@/lib/auth'
import {
  hasProcessedScanReceipt,
  rememberProcessedScanReceipt,
  scopedCashierStorageKeys,
} from '@/features/cashier/cashier-storage'
import {
  clearIntervalRef,
  clearTimerRef,
  payloadMatchesSession,
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  WS_WATCHDOG_INTERVAL_MS,
} from '@/lib/ws-session'
import type { CustomerTelegramStatus, Product } from '@/types/api'

type UseCashierSocketOptions = {
  onProductFound: (product: Product, scanId?: string | null) => void
  onCustomerTelegramStatus: (customer: CustomerTelegramStatus) => void
}

const MOBILE_READY_HINT_TTL_MS = 2 * 60 * 1000

function getMobileReadyStorageKey(sessionToken?: string | null) {
  return sessionToken ? `flowpos:cashier:mobile-ready:${sessionToken}` : null
}

function readStoredMobileReady(storageKey: string | null) {
  if (!storageKey) return false
  try {
    const raw = window.sessionStorage.getItem(storageKey)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { ready?: unknown; updatedAt?: unknown }
    const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    return parsed.ready === true && Date.now() - updatedAt <= MOBILE_READY_HINT_TTL_MS
  } catch {
    return false
  }
}

function writeStoredMobileReady(storageKey: string | null, ready: boolean) {
  if (!storageKey) return
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify({ ready, updatedAt: Date.now() }))
  } catch {
    // Storage availability should never block scanner operation.
  }
}

export function useCashierSocket({ onProductFound, onCustomerTelegramStatus }: UseCashierSocketOptions) {
  const session = getStoredSessionSnapshot()
  const mobileReadyStorageKey = getMobileReadyStorageKey(session?.sessionToken)
  const [mobileReady, setMobileReady] = useState(() => readStoredMobileReady(mobileReadyStorageKey))
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const heartbeatRef = useRef<number | null>(null)
  const watchdogRef = useRef<number | null>(null)
  const lastSocketActivityRef = useRef<number>(Date.now())
  const onProductFoundRef = useRef(onProductFound)
  const onCustomerTelegramStatusRef = useRef(onCustomerTelegramStatus)
  const storageKeys = scopedCashierStorageKeys()

  useEffect(() => {
    onProductFoundRef.current = onProductFound
    onCustomerTelegramStatusRef.current = onCustomerTelegramStatus
  }, [onCustomerTelegramStatus, onProductFound])

  useEffect(() => {
    if (!session?.sessionToken) return

    let cancelled = false
    const sessionToken = session.sessionToken
    const processedScansKey = storageKeys.processedScans

    const markMobileReady = (ready: boolean) => {
      setMobileReady(ready)
      writeStoredMobileReady(mobileReadyStorageKey, ready)
    }

    const cleanupSocket = () => {
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

    const connect = () => {
      if (cancelled) return
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        return
      }
      const ws = new WebSocket(`${resolveWsOrigin(true)}/ws/${sessionToken}`)
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
        ws.send(JSON.stringify({ type: 'desktop_ready', session: sessionToken }))
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

      ws.onclose = () => {
        if (wsRef.current !== ws) return
        setMobileReady(false)
        clearIntervalRef(heartbeatRef)
        clearIntervalRef(watchdogRef)
        if (wsRef.current === ws) {
          wsRef.current = null
        }
        if (cancelled) return
        clearTimerRef(reconnectTimerRef)
        reconnectTimerRef.current = window.setTimeout(connect, 2_000)
      }

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return
        lastSocketActivityRef.current = Date.now()
        try {
          const payload = JSON.parse(event.data) as Record<string, unknown>
          if (!payloadMatchesSession(payload, sessionToken)) return

          if (payload.type === 'product_found' && payload.product && typeof payload.product === 'object') {
            const scanId = typeof payload.scan_id === 'string' ? payload.scan_id : null
            if (scanId && hasProcessedScanReceipt(processedScansKey, scanId)) {
              return
            }
            if (scanId) {
              rememberProcessedScanReceipt(processedScansKey, scanId)
            }
            onProductFoundRef.current(payload.product as Product, scanId)
          } else if (payload.type === 'add_product_request' && typeof payload.barcode === 'string') {
            window.dispatchEvent(
              new CustomEvent('flowpos:add-product-request', {
                detail: { barcode: payload.barcode },
              }),
            )
          } else if (payload.type === 'customer_telegram_status' && payload.customer && typeof payload.customer === 'object') {
            onCustomerTelegramStatusRef.current(payload.customer as CustomerTelegramStatus)
          } else if (payload.type === 'mobile_connected' || payload.type === 'mobile_ready') {
            markMobileReady(true)
          } else if (payload.type === 'mobile_disconnected') {
            markMobileReady(false)
          }
        } catch {
          // ignore malformed messages
        }
      }
    }

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
      cleanupSocket()
    }
  }, [mobileReadyStorageKey, session?.sessionToken, storageKeys.processedScans])

  return { mobileReady, wsRef }
}
