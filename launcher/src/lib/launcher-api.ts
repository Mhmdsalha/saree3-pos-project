import type {
  LauncherCustomer,
  LauncherStatus,
  LicenseStatus,
  AdminRecoveryOtpRequest,
  AdminRecoveryOtpVerify,
  AdminRecoveryReset,
  AdminRecoverySecretVerify,
  AdminRecoveryStatus,
  ManagerTelegramSetupStatus,
  NetworkInfo,
  RuntimeHealth,
  SetupPayload,
  Storefront,
  StoreProfile,
  TelegramSettings,
} from '@/types'

const DEFAULT_BACKEND_ORIGIN = 'https://127.0.0.1:8000'
const REQUEST_TIMEOUT_MS = 7000

export function resolveLauncherApiOrigin() {
  return window.localStorage.getItem('flowpos_launcher_api_origin') || DEFAULT_BACKEND_ORIGIN
}

export function setLauncherApiOrigin(origin: string) {
  window.localStorage.setItem('flowpos_launcher_api_origin', origin)
}

async function launcherRequest<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  headers.set('X-FlowPOS-Launcher', 'true')
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(`${resolveLauncherApiOrigin()}${path}`, {
      ...init,
      headers,
      signal: init.signal || controller.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('انتهت مهلة الاتصال بالسيرفر المحلي. تحقق أن السيرفر يعمل ثم أعد المحاولة.')
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    try {
      const parsed = JSON.parse(raw) as { detail?: string }
      throw new Error(parsed.detail || raw || `Launcher request failed: ${response.status}`)
    } catch {
      throw new Error(raw || `Launcher request failed: ${response.status}`)
    }
  }

  return (await response.json()) as T
}

function normalizeOrigin(origin: string) {
  return String(origin || '').trim().replace(/\/+$/, '')
}

async function publicRequest<T>(origin: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${normalizeOrigin(origin)}${path}`, init)

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    try {
      const parsed = JSON.parse(raw) as { detail?: string }
      throw new Error(parsed.detail || raw || `Public request failed: ${response.status}`)
    } catch {
      throw new Error(raw || `Public request failed: ${response.status}`)
    }
  }

  return (await response.json()) as T
}

export function loadLauncherStatus() {
  return launcherRequest<LauncherStatus>('/launcher/status')
}

export function loadRuntimeHealth() {
  return launcherRequest<RuntimeHealth>('/health')
}

export function runLauncherSetup(payload: SetupPayload) {
  return launcherRequest<StoreProfile>('/launcher/setup', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function startManagerTelegramSetupLink() {
  return launcherRequest<ManagerTelegramSetupStatus>('/launcher/setup/manager-telegram-link', {
    method: 'POST',
  })
}

export function loadManagerTelegramSetupStatus() {
  return launcherRequest<ManagerTelegramSetupStatus>('/launcher/setup/manager-telegram-link')
}

export function updateStoreProfile(payload: Partial<StoreProfile>) {
  return launcherRequest<StoreProfile>('/launcher/store-profile', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function loadTelegramSettings() {
  return launcherRequest<TelegramSettings>('/launcher/telegram')
}

export function updateTelegramSettings(payload: Pick<TelegramSettings, 'telegram_enabled' | 'telegram_auto_send' | 'telegram_mode'>) {
  return launcherRequest<TelegramSettings>('/launcher/telegram', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function loadCustomers() {
  return launcherRequest<LauncherCustomer[]>('/launcher/customers')
}

export function sendTelegramTest(customerId: number) {
  return launcherRequest<{ ok: boolean }>('/launcher/telegram/test', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerId }),
  })
}

export function loadAdminRecoveryStatus() {
  return launcherRequest<AdminRecoveryStatus>('/launcher/admin-recovery/status')
}

export function requestAdminRecoveryOtp() {
  return launcherRequest<AdminRecoveryOtpRequest>('/launcher/admin-recovery/request-otp', {
    method: 'POST',
  })
}

export function verifyAdminRecoveryOtp(otp: string) {
  return launcherRequest<AdminRecoveryOtpVerify>('/launcher/admin-recovery/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ otp }),
  })
}

export function verifyAdminRecoverySecret(recoveryToken: string, answer: string) {
  return launcherRequest<AdminRecoverySecretVerify>('/launcher/admin-recovery/verify-secret', {
    method: 'POST',
    body: JSON.stringify({ recovery_token: recoveryToken, answer }),
  })
}

export function resetAdminRecoveryPassword(payload: {
  recovery_token: string
  new_password: string
  confirm_password: string
  new_username?: string | null
}) {
  return launcherRequest<AdminRecoveryReset>('/launcher/admin-recovery/reset', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function loadCategorySuggestions(storeType: string) {
  return launcherRequest<{ store_type: string; suggestions: string[] }>(`/launcher/category-templates/${encodeURIComponent(storeType)}`)
}

export function loadLicenseStatus() {
  return launcherRequest<LicenseStatus>('/launcher/license')
}

export function activateLicense(activationKey: string) {
  return launcherRequest<LicenseStatus>('/launcher/license/activate', {
    method: 'POST',
    body: JSON.stringify({ activation_key: activationKey }),
  })
}

export function loadNetworkInfo() {
  return launcherRequest<NetworkInfo>('/launcher/network-info')
}

export function loadPublicStorefront(origin: string) {
  return publicRequest<Storefront>(origin, '/launcher/public-storefront')
}

export function loadRemoteHealth(origin: string) {
  return publicRequest<RuntimeHealth>(origin, '/health')
}
