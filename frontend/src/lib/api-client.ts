import { getStoredUser } from '@/lib/auth'

function normalizeOrigin(origin: string) {
  const trimmed = origin.trim()
  if (!trimmed) return 'https://localhost:8000'
  return /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/+$/, '') : `https://${trimmed.replace(/\/+$/, '')}`
}

export function resolveApiOrigin(useStored = false) {
  const fromQuery = new URLSearchParams(window.location.search).get('server')
  if (fromQuery) return normalizeOrigin(fromQuery)

  if (useStored) {
    const stored = window.localStorage.getItem('pos_server')
    if (stored) return normalizeOrigin(stored)
  }

  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'https://localhost:8000'
  }

  return normalizeOrigin(`${window.location.hostname}:8000`)
}

export function resolveWsOrigin(useStored = false) {
  const httpOrigin = resolveApiOrigin(useStored)
  return httpOrigin.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
}

export async function apiRequest<T>(path: string, init: RequestInit = {}) {
  const session = getStoredUser()
  const headers = new Headers(init.headers)

  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  if (session?.token) {
    headers.set('Authorization', `Bearer ${session.token}`)
  }

  const response = await fetch(`${resolveApiOrigin(true)}${path}`, {
    ...init,
    headers,
  })

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    let detail = raw

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { detail?: string }
        detail = parsed.detail || raw
      } catch {
        detail = raw
      }
    }

    throw new Error(detail || `Request failed with status ${response.status}`)
  }

  return (await response.json()) as T
}

export function apiGet<T>(path: string) {
  return apiRequest<T>(path, { method: 'GET' })
}
