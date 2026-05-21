import { useEffect, useRef } from 'react'
import { resolveWsOrigin } from '@/lib/api-client'
import { clearIntervalRef, clearTimerRef, payloadMatchesSession, WS_PING_INTERVAL_MS } from '@/lib/ws-session'

type UseProductRequestSocketOptions = {
  enabled: boolean
  sessionToken: string
}

export function useProductRequestSocket({ enabled, sessionToken }: UseProductRequestSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const heartbeatRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled || !sessionToken) return

    let cancelled = false

    const cleanupSocket = () => {
      clearIntervalRef(heartbeatRef)
      clearTimerRef(reconnectTimerRef)
      if (!wsRef.current) return
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

    const connect = () => {
      if (cancelled) return
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return

      const ws = new WebSocket(`${resolveWsOrigin(true)}/ws/${sessionToken}`)
      wsRef.current = ws

      ws.onopen = () => {
        if (wsRef.current !== ws) return
        ws.send(JSON.stringify({ type: 'desktop_ready', session: sessionToken }))
        clearTimerRef(reconnectTimerRef)
        clearIntervalRef(heartbeatRef)
        heartbeatRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, WS_PING_INTERVAL_MS)
      }

      ws.onclose = () => {
        if (wsRef.current !== ws) return
        clearIntervalRef(heartbeatRef)
        wsRef.current = null
        if (cancelled) return
        clearTimerRef(reconnectTimerRef)
        reconnectTimerRef.current = window.setTimeout(connect, 2_000)
      }

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return
        try {
          const payload = JSON.parse(event.data) as Record<string, unknown>
          if (!payloadMatchesSession(payload, sessionToken)) return
          if (payload.type === 'add_product_request' && typeof payload.barcode === 'string') {
            window.dispatchEvent(
              new CustomEvent('flowpos:add-product-request', {
                detail: { barcode: payload.barcode },
              }),
            )
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
  }, [enabled, sessionToken])
}
