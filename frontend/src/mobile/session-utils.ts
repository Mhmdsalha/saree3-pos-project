import { getStoredUser, saveStoredSession, type StoredSession } from '@/lib/auth'
import { restoreMobileSessionFromPendingScans } from '@/lib/offline-db'
import type { LoginResponse } from '@/types/api'

const MOBILE_SESSION_BACKUP_KEY = 'flowpos_mobile_session_v1'
const MOBILE_SESSION_BACKUP_MAX_AGE_MS = 12 * 60 * 60 * 1000

type MobileBootstrapResponse = {
  access_token: string
  session_token: string
  user: StoredSession['user']
}

type ErrorPayload = {
  detail?: string
} | null

export function normalizeOrigin(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return 'https://localhost:8000'
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '')
  return `https://${trimmed.replace(/\/+$/, '')}`
}

export function defaultMobileServer() {
  const stored = getStoredUser()
  if (stored?.serverUrl) return stored.serverUrl
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'https://localhost:8000'
  }
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    return normalizeOrigin(window.location.origin)
  }
  return 'https://localhost:8000'
}

function saveMobileSessionBackup(session: StoredSession) {
  try {
    window.localStorage.setItem(
      MOBILE_SESSION_BACKUP_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        session,
      }),
    )
  } catch {
    // Best effort only; sessionStorage remains the primary in-tab store.
  }
}

export function clearMobileSessionBackup() {
  try {
    window.localStorage.removeItem(MOBILE_SESSION_BACKUP_KEY)
  } catch {
    // ignore
  }
}

export function getMobileSessionBackup() {
  try {
    const raw = window.localStorage.getItem(MOBILE_SESSION_BACKUP_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { savedAt?: number; session?: StoredSession }
    if (!parsed.session || !parsed.savedAt || Date.now() - parsed.savedAt > MOBILE_SESSION_BACKUP_MAX_AGE_MS) {
      clearMobileSessionBackup()
      return null
    }
    return parsed.session
  } catch {
    clearMobileSessionBackup()
    return null
  }
}

export function persistMobileSession(session: StoredSession) {
  const saved = saveStoredSession(session)
  saveMobileSessionBackup(saved)
  return saved
}

export async function fetchMobileUser(serverUrl: string, token: string) {
  const response = await fetch(`${normalizeOrigin(serverUrl)}/users/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) {
    throw new Error('تعذر تحميل جلسة المستخدم الحالية.')
  }
  return (await response.json()) as LoginResponse['user']
}

export async function restoreMobileSession(candidate: StoredSession | null) {
  if (!candidate) return null

  const normalizedServerUrl = normalizeOrigin(candidate.serverUrl)
  if (!candidate.token) {
    return null
  }

  const user = await fetchMobileUser(normalizedServerUrl, candidate.token)
  return persistMobileSession({
    ...candidate,
    serverUrl: normalizedServerUrl,
    user,
  })
}

export async function restoreMobileOfflineBridge() {
  const pendingSession = await restoreMobileSessionFromPendingScans()
  if (!pendingSession) return null

  return persistMobileSession({
    serverUrl: pendingSession.serverUrl,
    token: '',
    sessionToken: pendingSession.sessionToken,
    user: pendingSession.user,
  })
}

export async function consumeMobileBootstrap(bootstrapToken: string, serverOrigin = window.location.origin) {
  const response = await fetch(`${normalizeOrigin(serverOrigin)}/sessions/mobile-bootstrap/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrap_token: bootstrapToken }),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ErrorPayload
    throw new Error(payload?.detail || 'تعذر استكمال ربط الموبايل الآمن.')
  }

  const payload = (await response.json()) as MobileBootstrapResponse
  return persistMobileSession({
    serverUrl: normalizeOrigin(serverOrigin),
    token: payload.access_token,
    sessionToken: payload.session_token,
    user: payload.user,
  })
}
