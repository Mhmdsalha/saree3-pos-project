import type { User } from '@/types/api'

export type StoredSession = {
  serverUrl: string
  token: string
  sessionToken: string
  user: User
}

const KEYS = {
  server: 'pos_server',
  token: 'pos_token',
  user: 'pos_user',
  session: 'pos_session',
} as const

const CASHIER_DRAFT_KEY_PREFIX = 'pos_draft_invoice'
const CASHIER_HELD_KEY_PREFIX = 'pos_held_invoices'
const CASHIER_PROCESSED_SCANS_KEY_PREFIX = 'pos_processed_mobile_scans'

function migrateSensitiveSessionStorage() {
  const token = window.localStorage.getItem(KEYS.token)
  const rawUser = window.localStorage.getItem(KEYS.user)
  const sessionToken = window.localStorage.getItem(KEYS.session)

  if (token && !window.sessionStorage.getItem(KEYS.token)) {
    window.sessionStorage.setItem(KEYS.token, token)
  }
  if (rawUser && !window.sessionStorage.getItem(KEYS.user)) {
    window.sessionStorage.setItem(KEYS.user, rawUser)
  }
  if (sessionToken && !window.sessionStorage.getItem(KEYS.session)) {
    window.sessionStorage.setItem(KEYS.session, sessionToken)
  }

  if (token) window.localStorage.removeItem(KEYS.token)
  if (rawUser) window.localStorage.removeItem(KEYS.user)
  if (sessionToken) window.localStorage.removeItem(KEYS.session)
}

export function getStoredSessionSnapshot() {
  migrateSensitiveSessionStorage()
  const token = window.sessionStorage.getItem(KEYS.token)
  const sessionToken = window.sessionStorage.getItem(KEYS.session)
  const serverUrl = window.localStorage.getItem(KEYS.server)

  if (!token || !sessionToken || !serverUrl) {
    return null
  }

  return {
    token,
    sessionToken,
    serverUrl,
  }
}

export function getStoredUser(): StoredSession | null {
  migrateSensitiveSessionStorage()
  const snapshot = getStoredSessionSnapshot()
  const rawUser = window.sessionStorage.getItem(KEYS.user)

  if (!snapshot || !rawUser) {
    return null
  }

  try {
    return {
      token: snapshot.token,
      sessionToken: snapshot.sessionToken,
      serverUrl: snapshot.serverUrl,
      user: JSON.parse(rawUser) as User,
    }
  } catch {
    return null
  }
}

export function saveStoredSession(session: StoredSession) {
  window.localStorage.setItem(KEYS.server, session.serverUrl)
  window.sessionStorage.setItem(KEYS.token, session.token)
  window.sessionStorage.setItem(KEYS.user, JSON.stringify(session.user))
  window.sessionStorage.setItem(KEYS.session, session.sessionToken)
  window.localStorage.removeItem(KEYS.token)
  window.localStorage.removeItem(KEYS.user)
  window.localStorage.removeItem(KEYS.session)
  return session
}

export function clearStoredSession() {
  window.localStorage.removeItem(KEYS.server)
  window.localStorage.removeItem(KEYS.token)
  window.localStorage.removeItem(KEYS.user)
  window.localStorage.removeItem(KEYS.session)
  window.sessionStorage.removeItem(KEYS.token)
  window.sessionStorage.removeItem(KEYS.user)
  window.sessionStorage.removeItem(KEYS.session)
}

export function clearCashierStorage(sessionToken?: string | null) {
  const scopedDraftKey = sessionToken ? `${CASHIER_DRAFT_KEY_PREFIX}:${sessionToken}` : null
  const scopedHeldKey = sessionToken ? `${CASHIER_HELD_KEY_PREFIX}:${sessionToken}` : null
  const scopedProcessedScansKey = sessionToken ? `${CASHIER_PROCESSED_SCANS_KEY_PREFIX}:${sessionToken}` : null

  if (scopedDraftKey) {
    window.localStorage.removeItem(scopedDraftKey)
  }
  if (scopedHeldKey) {
    window.localStorage.removeItem(scopedHeldKey)
  }
  if (scopedProcessedScansKey) {
    window.localStorage.removeItem(scopedProcessedScansKey)
  }

  window.localStorage.removeItem(CASHIER_DRAFT_KEY_PREFIX)
  window.localStorage.removeItem(CASHIER_HELD_KEY_PREFIX)
  window.localStorage.removeItem(CASHIER_PROCESSED_SCANS_KEY_PREFIX)
}

export async function logoutStoredSession(session: StoredSession | null) {
  if (!session) {
    clearStoredSession()
    return
  }

  try {
    await fetch(`${session.serverUrl}/sessions/close`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    })
  } catch {
    // ignore network/logout cleanup failures
  }

  try {
    await fetch(`${session.serverUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    })
  } catch {
    // ignore network/logout cleanup failures
  }

  clearStoredSession()
  clearCashierStorage(session.sessionToken)
}
