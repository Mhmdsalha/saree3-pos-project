export const WS_PING_INTERVAL_MS = 15_000
export const WS_WATCHDOG_INTERVAL_MS = 5_000
export const WS_PONG_TIMEOUT_MS = 45_000

type TimerRefLike = { current: number | null }

export function payloadMatchesSession(payload: Record<string, unknown>, sessionToken: string) {
  const payloadSession =
    (typeof payload.session_token === 'string' && payload.session_token) ||
    (typeof payload.session === 'string' && payload.session) ||
    null
  return !payloadSession || payloadSession === sessionToken
}

export function clearTimerRef(timerRef: TimerRefLike) {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }
}

export function clearIntervalRef(timerRef: TimerRefLike) {
  if (timerRef.current !== null) {
    window.clearInterval(timerRef.current)
    timerRef.current = null
  }
}
