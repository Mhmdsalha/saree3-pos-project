import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import {
  loadCategorySuggestions,
  loadAdminRecoveryStatus,
  loadCustomers,
  loadLicenseStatus,
  loadNetworkInfo,
  loadRuntimeHealth,
  loadTelegramSettings,
  requestAdminRecoveryOtp,
  resetAdminRecoveryPassword,
  resolveLauncherApiOrigin,
  sendTelegramTest,
  updateStoreProfile,
  updateTelegramSettings,
  verifyAdminRecoveryOtp,
  verifyAdminRecoverySecret,
} from '@/lib/launcher-api'
import { SYSTEM_BRAND_NAME, SYSTEM_BRAND_TAGLINE, SYSTEM_LOGO_DARK_URL } from '@/lib/system-branding'
import {
  BackupIcon,
  LinkIcon,
  PlayIcon,
  ServerIcon,
  ShieldIcon,
  StoreIcon,
  SupportIcon,
  TelegramIcon,
} from '@/components/ui/launcher-icons'
import { LauncherToast, type LauncherToastState } from '@/components/ui/launcher-toast'
import {
  copyLogoToStoreAssets,
  createBackup,
  getAppPaths,
  getServerState,
  isTauriRuntime,
  openExternal,
  restartServer,
  saveLogoFile,
  startServer,
  stopServer,
} from '@/lib/tauri'
import type {
  AppPaths,
  AdminRecoveryStatus,
  LauncherCustomer,
  LauncherStatus,
  NetworkInfo,
  RuntimeHealth,
  ServerState,
  StoreProfile,
  StoreType,
  TelegramSettings,
} from '@/types'

type DashboardPageProps = {
  status: LauncherStatus
  onRefresh: (options?: { ensureServer?: boolean }) => Promise<void>
  onResetMode: () => Promise<void>
  onOpenLicenseGate: () => void
}

type ActivePanel = 'store' | 'license' | 'server' | 'telegram' | 'support' | 'recovery' | null

type StoreProfileFormState = {
  store_name: string
  country: string
  currency: string
  store_type: StoreType
  phone: string
  address: string
  logo_path: string
}

const DASH = '\u2014'
const TXT = {
  supermarket: '\u0633\u0648\u0628\u0631\u0645\u0627\u0631\u0643\u062a',
  clothing: '\u0645\u0644\u0627\u0628\u0633',
  pharmacy: '\u0635\u064a\u062f\u0644\u064a\u0629',
  cosmetics: '\u0645\u0633\u062a\u062d\u0636\u0631\u0627\u062a \u062a\u062c\u0645\u064a\u0644',
  diagnostics: '\u062a\u0641\u0627\u0635\u064a\u0644',
  close: '\u0625\u063a\u0644\u0627\u0642',
  noStoreName: '\u0627\u0644\u0645\u062a\u062c\u0631',
  hostMode: 'Host Mode',
  editStore: '\u062a\u0639\u062f\u064a\u0644 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a',
  licenseDetails: '\u0639\u0631\u0636 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644',
  serverDetails: '\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u0633\u064a\u0631\u0641\u0631',
  manageTelegram: '\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u062a\u0644\u062c\u0631\u0627\u0645',
  support: '\u0627\u0644\u062f\u0639\u0645 \u0627\u0644\u0641\u0646\u064a',
  backup: '\u0646\u0633\u062e \u0627\u062d\u062a\u064a\u0627\u0637\u064a',
  copyClientLink: '\u0646\u0633\u062e \u0631\u0627\u0628\u0637 \u0627\u0644\u0639\u0645\u064a\u0644',
  openSystem: '\u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0646\u0638\u0627\u0645',
  running: '\u064a\u0639\u0645\u0644',
  starting: '\u0642\u064a\u062f \u0627\u0644\u062a\u0634\u063a\u064a\u0644',
  stopped: '\u0645\u062a\u0648\u0642\u0641',
  error: '\u062e\u0637\u0623',
  unknown: '\u063a\u064a\u0631 \u0645\u0639\u0631\u0648\u0641',
  trial: '\u062a\u062c\u0631\u064a\u0628\u064a',
  expired: '\u0645\u0646\u062a\u0647\u064a',
  active: '\u0645\u0641\u0639\u0644',
  invalid: '\u063a\u064a\u0631 \u0635\u0627\u0644\u062d',
  pending: '\u0642\u064a\u062f \u0627\u0644\u0627\u0646\u062a\u0638\u0627\u0631',
  linked: '\u0645\u0641\u0639\u0644',
  notLinked: '\u063a\u064a\u0631 \u0645\u0641\u0639\u0644',
  saveChanges: '\u062d\u0641\u0638 \u0627\u0644\u062a\u0639\u062f\u064a\u0644\u0627\u062a',
  cancel: '\u0625\u0644\u063a\u0627\u0621',
  chooseLogo: '\u0627\u062e\u062a\u064a\u0627\u0631 \u0627\u0644\u0634\u0639\u0627\u0631',
  noSuggestions: '\u0644\u0627 \u062a\u0648\u062c\u062f \u0627\u0642\u062a\u0631\u0627\u062d\u0627\u062a \u062d\u0627\u0644\u064a\u0629',
  noLogoYet: '\u0644\u0645 \u064a\u062a\u0645 \u0627\u062e\u062a\u064a\u0627\u0631 \u0634\u0639\u0627\u0631 \u0628\u0639\u062f.',
  noTelegramSettings: '\u062a\u0639\u0630\u0631 \u062a\u062d\u0645\u064a\u0644 \u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062a\u0644\u062c\u0631\u0627\u0645.',
  copyFailed: '\u062a\u0639\u0630\u0631 \u0627\u0644\u0646\u0633\u062e \u0625\u0644\u0649 \u0627\u0644\u062d\u0627\u0641\u0638\u0629.',
} as const

const STORE_TYPE_LABELS: Record<StoreType, string> = {
  supermarket: TXT.supermarket,
  clothing: TXT.clothing,
  pharmacy: TXT.pharmacy,
  cosmetics: TXT.cosmetics,
}

function createServerState(port: number): ServerState {
  return {
    status: 'stopped',
    port,
    url: `https://127.0.0.1:${port}/frontend-react/`,
    mobile_url: `https://127.0.0.1:${port}/mobile-react/`,
    pid: null,
    error: null,
  }
}

function createEmptyPaths(): AppPaths {
  return {
    app_data_dir: '',
    config_dir: '',
    data_dir: '',
    uploads_dir: '',
    backups_dir: '',
    database_path: '',
    logo_dir: '',
  }
}

function createEmptyNetworkInfo(port: number): NetworkInfo {
  return {
    lan_ip: '127.0.0.1',
    desktop_url: `https://127.0.0.1:${port}/frontend-react/`,
    mobile_url: `https://127.0.0.1:${port}/mobile-react/`,
  }
}

function buildStoreProfileForm(store?: StoreProfile | null): StoreProfileFormState {
  return {
    store_name: store?.store_name || '',
    country: store?.country || '',
    currency: store?.currency || '',
    store_type: (store?.store_type || 'supermarket') as StoreType,
    phone: store?.phone || '',
    address: store?.address || '',
    logo_path: store?.logo_path || '',
  }
}

function formatDate(value?: string | null) {
  if (!value) return DASH
  try {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return value
    const day = String(parsed.getDate()).padStart(2, '0')
    const month = String(parsed.getMonth() + 1).padStart(2, '0')
    const year = String(parsed.getFullYear())
    const hours = String(parsed.getHours()).padStart(2, '0')
    const minutes = String(parsed.getMinutes()).padStart(2, '0')
    return parsed.getHours() !== 0 || parsed.getMinutes() !== 0
      ? `${day}/${month}/${year} ${hours}:${minutes}`
      : `${day}/${month}/${year}`
  } catch {
    return value
  }
}

function parseTimestamp(value?: string | null) {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function padClockUnit(value: number) {
  return String(value).padStart(2, '0')
}

function formatLiveRemaining(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const clock = `${padClockUnit(hours)}:${padClockUnit(minutes)}:${padClockUnit(seconds)}`
  return days > 0 ? `${days} يوم ${clock}` : clock
}

function buildLicenseRemainingCopy(license: LauncherStatus['license'], remainingMs: number | null) {
  if (!license) return '\u0644\u0627 \u062a\u0648\u062c\u062f \u0628\u064a\u0627\u0646\u0627\u062a \u062d\u0627\u0644\u064a\u0629'

  if (license.license_status === 'trial_active') {
    return remainingMs != null && remainingMs > 0
      ? `\u0645\u062a\u0628\u0642\u064a ${formatLiveRemaining(remainingMs)}`
      : '\u0642\u064a\u062f \u062d\u0633\u0627\u0628 \u0627\u0644\u0648\u0642\u062a'
  }

  if (license.license_status === 'trial_expired') {
    return '\u0627\u0646\u062a\u0647\u062a \u0627\u0644\u0641\u062a\u0631\u0629 \u0627\u0644\u062a\u062c\u0631\u064a\u0628\u064a\u0629'
  }

  if (license.license_status === 'active') {
    if (remainingMs != null && remainingMs > 0) return `\u064a\u0646\u062a\u0647\u064a \u0628\u0639\u062f ${formatLiveRemaining(remainingMs)}`
    return '\u0627\u0644\u062a\u0631\u062e\u064a\u0635 \u0645\u0641\u0639\u0644'
  }

  if (license.remaining_days != null) return `${license.remaining_days} \u0623\u064a\u0627\u0645 \u0645\u062a\u0628\u0642\u064a\u0629`
  return '\u0644\u0627 \u062a\u0648\u062c\u062f \u0628\u064a\u0627\u0646\u0627\u062a \u062d\u0627\u0644\u064a\u0629'
}

function resolveLicenseTargetTimestamp(license: LauncherStatus['license'] | null | undefined) {
  return parseTimestamp(
    license?.license_status === 'trial_active' || license?.license_status === 'trial_expired'
      ? license?.trial_expires_at
      : license?.expires_at,
  )
}

function resolveTrustedLicenseBaseline(license: LauncherStatus['license'] | null | undefined) {
  const target = resolveLicenseTargetTimestamp(license)
  const current = parseTimestamp(license?.current_time_utc)
  if (!license?.time_trusted || target == null || current == null) return null
  return { target, current }
}

function LiveLicenseTicker({ license }: { license: LauncherStatus['license'] | null | undefined }) {
  const baseline = useMemo(
    () => resolveTrustedLicenseBaseline(license),
    [license?.current_time_utc, license?.expires_at, license?.license_status, license?.time_trusted, license?.trial_expires_at],
  )
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    setElapsedMs(0)
    if (!baseline) return

    const startedAt = performance.now()
    const interval = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAt)
    }, 1000)

    return () => window.clearInterval(interval)
  }, [baseline?.current, baseline?.target])

  if (!baseline) {
    if (license?.remaining_days == null) return null
    return (
      <div className="license-live-ticker">
        <span className="license-live-dot" aria-hidden="true" />
        <strong>{`${license.remaining_days} يوم`}</strong>
      </div>
    )
  }
  const remainingMs = Math.max(baseline.target - (baseline.current + elapsedMs), 0)
  if (remainingMs <= 0) {
    return (
      <div className="license-live-ticker">
        <span className="license-live-dot" aria-hidden="true" />
        <strong>00:00:00</strong>
      </div>
    )
  }

  return (
    <div className="license-live-ticker">
      <span className="license-live-dot" aria-hidden="true" />
      <strong>{formatLiveRemaining(remainingMs)}</strong>
    </div>
  )
}

function formatStoreTypeLabel(storeType?: string | null) {
  if (!storeType) return DASH
  return STORE_TYPE_LABELS[storeType as StoreType] || storeType
}

function formatServerStateLabel(status?: string | null) {
  switch (status) {
    case 'running':
      return TXT.running
    case 'starting':
      return TXT.starting
    case 'stopped':
      return TXT.stopped
    case 'error':
      return TXT.error
    default:
      return status || TXT.unknown
  }
}

function formatLicenseStatusLabel(status?: string | null) {
  switch (status) {
    case 'trial_active':
      return TXT.trial
    case 'trial_expired':
      return TXT.expired
    case 'active':
      return TXT.active
    case 'invalid':
      return TXT.invalid
    case 'pending':
      return TXT.pending
    default:
      return status || TXT.pending
  }
}

function formatSubscriptionTermLabel(subscriptionTerm?: string | null, licenseType?: string | null) {
  const raw = String(subscriptionTerm || '').trim().toLowerCase()
  if (licenseType === 'trial' || raw === 'trial') return 'فترة تجريبية'
  switch (raw) {
    case 'lifetime':
      return 'مدى الحياة'
    case 'monthly':
      return 'شهر'
    case 'quarterly':
      return '3 أشهر'
    case 'semiannual':
      return '6 أشهر'
    case 'yearly':
      return 'سنة'
    default:
      return raw || DASH
  }
}

function formatTelegramStatusLabel(storeLinked?: boolean | null) {
  if (storeLinked) return TXT.linked
  return TXT.notLinked
}

function formatTelegramModeLabel(mode?: string | null) {
  return mode === 'text' ? '\u0646\u0635\u064a' : 'PDF'
}

function isManagedLogoPath(value: string) {
  const normalized = String(value || '').trim()
  return normalized.includes('\\uploads\\logo\\') || normalized.includes('/uploads/logo/')
}

function buildStoredLogoPreviewUrl(store?: StoreProfile | null) {
  if (!store?.logo_path) return ''
  if (/^https?:\/\//i.test(store.logo_path)) return store.logo_path
  const version = encodeURIComponent(store.updated_at || store.logo_path)
  return `${resolveLauncherApiOrigin()}/launcher/store-logo?v=${version}`
}

function buildCertificateInstallUrl(mobileUrl: string) {
  const origin = String(mobileUrl || '').replace(/\/mobile-react\/?$/i, '').replace(/\/$/, '')
  return `${origin}/install-ca?cert_only=true`
}

function openNativeFilePicker(input: HTMLInputElement | null) {
  if (!input) return
  const picker = input as HTMLInputElement & { showPicker?: () => void }
  if (typeof picker.showPicker === 'function') {
    picker.showPicker()
    return
  }
  input.click()
}

function KeyValue({
  label,
  value,
  ltr = false,
  action,
}: {
  label: string
  value: ReactNode
  ltr?: boolean
  action?: ReactNode
}) {
  return (
    <div className="key-value-row">
      <strong>{label}</strong>
      <div className="key-value-content">
        <span className={ltr ? 'ltr-fragment' : undefined}>{value}</span>
        {action ? <span className="key-value-action">{action}</span> : null}
      </div>
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add('launcher-modal-open')
    return () => {
      document.body.classList.remove('launcher-modal-open')
    }
  }, [])

  return createPortal(
    <div className="launcher-modal-backdrop" onClick={onClose}>
      <section className="launcher-modal" onClick={(event) => event.stopPropagation()}>
        <header className="launcher-modal-header">
          <div>
            <div className="eyebrow">{TXT.diagnostics}</div>
            <h3>{title}</h3>
          </div>
          <button type="button" className="icon-ghost-button" onClick={onClose} aria-label={TXT.close}>
            x
          </button>
        </header>
        <div className="launcher-modal-body">{children}</div>
      </section>
    </div>,
    document.body,
  )
}

function CardTitle({ title, accent }: { title: string; accent: ReactNode }) {
  return (
    <div className="summary-card-header">
      <span className="summary-card-title">{title}</span>
      <span className="summary-card-accent summary-card-icon-wrap" aria-hidden="true">
        {accent}
      </span>
    </div>
  )
}

function ActionTile({
  title,
  icon,
  primary = false,
  onClick,
  disabled,
}: {
  title: string
  icon: ReactNode
  primary?: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button type="button" className={primary ? 'action-tile primary' : 'action-tile'} onClick={onClick} disabled={disabled}>
      <span className="action-tile-icon" aria-hidden="true">{icon}</span>
      <span>{title}</span>
    </button>
  )
}

function AdminRecoveryModal({
  status,
  onClose,
  onSuccess,
  showToast,
}: {
  status: AdminRecoveryStatus | null
  onClose: () => void
  onSuccess: () => Promise<void> | void
  showToast: (text: string, tone?: LauncherToastState['tone']) => void
}) {
  const [step, setStep] = useState<'start' | 'otp' | 'secret' | 'reset' | 'success'>('start')
  const [busy, setBusy] = useState(false)
  const [otp, setOtp] = useState('')
  const [secretAnswer, setSecretAnswer] = useState('')
  const [recoveryToken, setRecoveryToken] = useState('')
  const [secretQuestion, setSecretQuestion] = useState('')
  const [adminUsername, setAdminUsername] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)

  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = window.setInterval(() => {
      setResendCooldown((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendCooldown])

  const requestOtp = async () => {
    setBusy(true)
    try {
      const result = await requestAdminRecoveryOtp()
      setResendCooldown(result.resend_cooldown_seconds || 60)
      setStep('otp')
      showToast('تم إرسال رمز التحقق إلى تلجرام المدير', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'تعذر إرسال رمز التحقق.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const verifyOtp = async () => {
    setBusy(true)
    try {
      const result = await verifyAdminRecoveryOtp(otp)
      setRecoveryToken(result.recovery_token)
      setSecretQuestion(result.secret_question)
      setStep('secret')
      showToast('تم التحقق من الرمز بنجاح', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'رمز التحقق غير صحيح', 'error')
    } finally {
      setBusy(false)
    }
  }

  const verifySecret = async () => {
    setBusy(true)
    try {
      const result = await verifyAdminRecoverySecret(recoveryToken, secretAnswer)
      setAdminUsername(result.admin_username)
      setNewUsername(result.admin_username)
      setStep('reset')
      showToast('تم التحقق من الإجابة بنجاح', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'الإجابة غير صحيحة', 'error')
    } finally {
      setBusy(false)
    }
  }

  const resetPassword = async () => {
    setBusy(true)
    try {
      const result = await resetAdminRecoveryPassword({
        recovery_token: recoveryToken,
        new_password: newPassword,
        confirm_password: confirmPassword,
        new_username: newUsername.trim() || null,
      })
      setAdminUsername(result.admin_username)
      setStep('success')
      await onSuccess()
      showToast('تم تغيير كلمة مرور المدير بنجاح', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'تعذر تغيير كلمة مرور المدير.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="استعادة حساب المدير" onClose={onClose}>
      {!status?.available ? (
        <div className="info-box">
          لم يتم إعداد طريقة استعادة حساب المدير بشكل صحيح. يجب توفر تلجرام المدير وسؤال الاستعادة وحساب مدير فعال.
        </div>
      ) : null}

      {status?.available && step === 'start' ? (
        <div className="space-y-4">
          <div className="modal-hero-strip">
            <div className="modal-hero-copy">
              <span className="modal-kicker">تلجرام المدير</span>
              <h4>{status.manager_telegram_masked || 'حساب المدير المرتبط'}</h4>
              <p>سيتم إرسال رمز التحقق إلى تلجرام المدير المرتبط مسبقًا. لا يمكن تغيير حساب تلجرام من هذه الشاشة.</p>
            </div>
          </div>
          <div className="button-row top-space">
            <button type="button" onClick={() => void requestOtp()} disabled={busy}>إرسال رمز التحقق</button>
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>{TXT.cancel}</button>
          </div>
        </div>
      ) : null}

      {step === 'otp' ? (
        <div className="wizard-grid compact">
          <label className="field"><span>رمز التحقق</span><input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" /></label>
          {resendCooldown > 0 ? <div className="info-box full-width">يمكنك إعادة إرسال رمز التحقق بعد {resendCooldown} ثانية.</div> : null}
          <div className="button-row top-space">
            <button type="button" onClick={() => void verifyOtp()} disabled={busy || otp.length !== 6}>تأكيد الرمز</button>
            <button type="button" className="secondary" onClick={() => void requestOtp()} disabled={busy || resendCooldown > 0}>إعادة الإرسال</button>
          </div>
        </div>
      ) : null}

      {step === 'secret' ? (
        <div className="wizard-grid compact">
          <div className="info-box full-width"><strong>سؤال الاستعادة</strong><p>{secretQuestion}</p></div>
          <label className="field"><span>إجابة الاستعادة</span><input type="password" value={secretAnswer} onChange={(event) => setSecretAnswer(event.target.value)} /></label>
          <div className="button-row top-space">
            <button type="button" onClick={() => void verifySecret()} disabled={busy || !secretAnswer.trim()}>تأكيد الإجابة</button>
          </div>
        </div>
      ) : null}

      {step === 'reset' ? (
        <div className="wizard-grid compact">
          <div className="info-box full-width"><strong>يمكنك الآن تغيير كلمة مرور المدير</strong><p>اسم المستخدم الحالي: <span className="ltr-fragment">{adminUsername}</span></p></div>
          <label className="field"><span>اسم مستخدم المدير</span><input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} /></label>
          <label className="field"><span>كلمة المرور الجديدة</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label className="field"><span>تأكيد كلمة المرور</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
          <div className="button-row top-space">
            <button type="button" onClick={() => void resetPassword()} disabled={busy || newPassword.length < 8 || newPassword !== confirmPassword}>تغيير كلمة المرور</button>
          </div>
        </div>
      ) : null}

      {step === 'success' ? (
        <div className="info-box">
          <strong>تم تغيير كلمة مرور المدير بنجاح</strong>
          <p>اسم المستخدم الحالي: <span className="ltr-fragment">{adminUsername}</span></p>
        </div>
      ) : null}
    </Modal>
  )
}

export function DashboardPage({ status, onRefresh, onResetMode, onOpenLicenseGate }: DashboardPageProps) {
  const logoInputRef = useRef<HTMLInputElement | null>(null)
  const busyActionRef = useRef<string | null>(null)
  const scannerAutoRestartRef = useRef({ inFlight: false, lastKey: '', lastAttemptAt: 0 })
  const [serverState, setServerState] = useState<ServerState>(() => createServerState(status.server_port))
  const [liveLicense, setLiveLicense] = useState(status.license ?? null)
  const [paths, setPaths] = useState<AppPaths>(createEmptyPaths)
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo>(() => createEmptyNetworkInfo(status.server_port))
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null)
  const [telegram, setTelegram] = useState<TelegramSettings | null>(null)
  const [recoveryStatus, setRecoveryStatus] = useState<AdminRecoveryStatus | null>(null)
  const [telegramQr, setTelegramQr] = useState('')
  const [certificateInstallQr, setCertificateInstallQr] = useState('')
  const [customers, setCustomers] = useState<LauncherCustomer[]>([])
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [toast, setToast] = useState<LauncherToastState | null>(null)
  const [storeForm, setStoreForm] = useState<StoreProfileFormState>(() => buildStoreProfileForm(status.store))
  const [draftLogoPreviewUrl, setDraftLogoPreviewUrl] = useState('')
  const [categorySuggestions, setCategorySuggestions] = useState<string[]>([])
  const [activePanel, setActivePanel] = useState<ActivePanel>(null)

  const reloadDashboardData = useCallback(async () => {
    const [
      nextServerState,
      nextPaths,
      nextNetworkInfo,
      nextRuntimeHealth,
      nextTelegram,
      nextCustomers,
      nextRecoveryStatus,
    ] =
      await Promise.all([
        getServerState().catch(() => createServerState(status.server_port)),
        getAppPaths().catch(() => createEmptyPaths()),
        loadNetworkInfo().catch(() => createEmptyNetworkInfo(status.server_port)),
        loadRuntimeHealth().catch(() => null),
        loadTelegramSettings().catch(() => null),
        loadCustomers().catch(() => []),
        loadAdminRecoveryStatus().catch(() => null),
      ])

    setServerState({ ...nextServerState, pid: nextServerState.pid ?? null, error: nextServerState.error ?? null })
    setPaths(nextPaths)
    setNetworkInfo(nextNetworkInfo)
    setRuntimeHealth(nextRuntimeHealth)
    setTelegram(nextTelegram)
    setRecoveryStatus(nextRecoveryStatus)
    setCustomers(nextCustomers)
    setSelectedCustomerId((current) => {
      if (current && nextCustomers.some((row) => row.id === current)) return current
      const firstActivated = nextCustomers.find((row) => row.telegram_activation_status === 'activated')
      return firstActivated?.id || nextCustomers[0]?.id || null
    })
  }, [status.server_port])

  useEffect(() => {
    busyActionRef.current = busyAction
  }, [busyAction])

  useEffect(() => {
    setServerState(createServerState(status.server_port))
  }, [status.server_port])

  useEffect(() => {
    setLiveLicense(status.license ?? null)
  }, [status.license])

  const refreshLiveLicense = useCallback(async () => {
    try {
      const next = await loadLicenseStatus()
      setLiveLicense(next)
      if (next.is_blocked) {
        await onRefresh({ ensureServer: false })
      }
    } catch {
      // Keep the last known state on lightweight refresh failures.
    }
  }, [onRefresh])

  useEffect(() => {
    void reloadDashboardData()
  }, [reloadDashboardData, status.initialized, status.server_port, status.store?.updated_at, status.license?.license_status])

  useEffect(() => {
    void refreshLiveLicense()
  }, [refreshLiveLicense, status.store?.store_id, status.license?.license_status])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshLiveLicense()
    }, 60_000)
    return () => window.clearInterval(interval)
  }, [refreshLiveLicense])

  useEffect(() => {
    setStoreForm(buildStoreProfileForm(status.store))
    setDraftLogoPreviewUrl((current) => {
      if (current.startsWith('blob:')) {
        URL.revokeObjectURL(current)
      }
      return ''
    })
  }, [status.store?.updated_at, status.store?.logo_path, status.store?.store_name, status.store?.store_type])

  useEffect(() => {
    if (!telegram?.link) {
      setTelegramQr('')
      return
    }

    void QRCode.toDataURL(telegram.link, { width: 180, margin: 1 }).then(setTelegramQr).catch(() => setTelegramQr(''))
  }, [telegram?.link])

  useEffect(() => {
    if (activePanel !== 'telegram') return

    const refreshTelegramPanel = async () => {
      try {
        const [nextTelegram, nextCustomers] = await Promise.all([loadTelegramSettings(), loadCustomers()])
        setTelegram(nextTelegram)
        setCustomers(nextCustomers)
        setSelectedCustomerId((current) => {
          if (current && nextCustomers.some((row) => row.id === current)) return current
          const firstActivated = nextCustomers.find((row) => row.telegram_activation_status === 'activated')
          return firstActivated?.id || nextCustomers[0]?.id || null
        })
      } catch {
        // Keep the last visible state if a lightweight refresh fails.
      }
    }

    void refreshTelegramPanel()
    const interval = window.setInterval(() => {
      void refreshTelegramPanel()
    }, 4000)
    return () => window.clearInterval(interval)
  }, [activePanel])

  useEffect(() => {
    void loadCategorySuggestions(storeForm.store_type).then((payload) => setCategorySuggestions(payload.suggestions)).catch(() => setCategorySuggestions([]))
  }, [storeForm.store_type])

  useEffect(() => {
    return () => {
      if (draftLogoPreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(draftLogoPreviewUrl)
      }
    }
  }, [draftLogoPreviewUrl])

  const store = status.store
  const license = liveLicense || status.license
  const localHttps = runtimeHealth?.local_https
  const localHttpsRestartRequired = Boolean(localHttps?.restart_required)
  const localHttpsIssue = localHttps?.active === false ? (localHttps.message || 'الموبايل غير جاهز حاليًا') : null
  const publicMobileUrl = localHttps?.mobile_url || networkInfo.mobile_url || null
  const certificateInstallUrl = buildCertificateInstallUrl(publicMobileUrl || networkInfo.mobile_url)
  const activatedCustomers = useMemo(() => customers.filter((row) => row.telegram_activation_status === 'activated'), [customers])
  const serverIsRunning = serverState.status === 'running' || serverState.status === 'starting'
  const persistedLogoPreviewUrl = useMemo(() => {
    const rawPath = storeForm.logo_path.trim()
    if (/^https?:\/\//i.test(rawPath)) return rawPath
    return buildStoredLogoPreviewUrl(store)
  }, [store, storeForm.logo_path])
  const logoPreviewSrc = draftLogoPreviewUrl || persistedLogoPreviewUrl || SYSTEM_LOGO_DARK_URL
  const trustedLicenseBaseline = useMemo(() => resolveTrustedLicenseBaseline(license), [license])
  const licenseRefreshDelayMs = trustedLicenseBaseline ? Math.max(trustedLicenseBaseline.target - trustedLicenseBaseline.current, 0) : null
  const licenseDaysLabel = license?.time_trusted === false
    ? '\u0642\u064a\u062f \u0645\u0632\u0627\u0645\u0646\u0629 \u0627\u0644\u0648\u0642\u062a \u0627\u0644\u0645\u0648\u062b\u0648\u0642'
    : trustedLicenseBaseline
      ? license?.license_status === 'trial_active'
        ? '\u0627\u0644\u0648\u0642\u062a \u0627\u0644\u0645\u062a\u0628\u0642\u064a \u064a\u064f\u062d\u0633\u0628 \u0645\u0646 \u0648\u0642\u062a \u0645\u0648\u062b\u0648\u0642'
        : license?.license_status === 'active'
          ? '\u0627\u0644\u0627\u0634\u062a\u0631\u0627\u0643 \u0645\u0631\u062a\u0628\u0637 \u0628\u0648\u0642\u062a \u0645\u0648\u062b\u0648\u0642'
          : buildLicenseRemainingCopy(license, null)
      : buildLicenseRemainingCopy(license, null)
  const licenseTermLabel = formatSubscriptionTermLabel(license?.subscription_term, license?.license_type)
  const licenseExpiryLabel = license?.license_status === 'trial_active' || license?.license_status === 'trial_expired'
    ? formatDate(license?.trial_expires_at)
    : license?.subscription_term === 'lifetime'
      ? 'لا ينتهي'
      : formatDate(license?.expires_at)
  const telegramStatus = formatTelegramStatusLabel(telegram?.store_linked)
  const storeLocation = [store?.country, store?.currency].filter(Boolean).join(' - ') || DASH

  const showToast = useCallback((text: string, tone: LauncherToastState['tone'] = 'info') => {
    setToast({ text, tone })
  }, [])

  useEffect(() => {
    if (licenseRefreshDelayMs == null || licenseRefreshDelayMs === 0) return
    const timeout = window.setTimeout(() => {
      void refreshLiveLicense()
    }, Math.min(licenseRefreshDelayMs + 250, 60_000))
    return () => window.clearTimeout(timeout)
  }, [licenseRefreshDelayMs, refreshLiveLicense])

  useEffect(() => {
    if (!certificateInstallUrl) {
      setCertificateInstallQr('')
      return
    }
    void QRCode.toDataURL(certificateInstallUrl, { width: 180, margin: 1 }).then(setCertificateInstallQr).catch(() => setCertificateInstallQr(''))
  }, [certificateInstallUrl])

  useEffect(() => {
    if (!status.initialized || serverState.status !== 'running') return

    let cancelled = false
    const watchLocalScannerEndpoint = async () => {
      if (busyActionRef.current !== null || scannerAutoRestartRef.current.inFlight) return

      try {
        const [nextRuntimeHealth, nextNetworkInfo] = await Promise.all([
          loadRuntimeHealth(),
          loadNetworkInfo().catch(() => null),
        ])
        if (cancelled) return

        setRuntimeHealth(nextRuntimeHealth)
        if (nextNetworkInfo) setNetworkInfo(nextNetworkInfo)

        const nextLocalHttps = nextRuntimeHealth.local_https
        if (!nextLocalHttps?.restart_required) return

        const restartKey = [
          nextLocalHttps.cert_lan_ip || 'missing-cert-ip',
          nextLocalHttps.lan_ip || nextNetworkInfo?.lan_ip || 'missing-current-ip',
          nextLocalHttps.port || status.server_port,
        ].join('|')
        const now = Date.now()

        if (
          scannerAutoRestartRef.current.lastKey === restartKey &&
          now - scannerAutoRestartRef.current.lastAttemptAt < 60_000
        ) {
          return
        }

        scannerAutoRestartRef.current = {
          inFlight: true,
          lastKey: restartKey,
          lastAttemptAt: now,
        }
        setBusyAction('auto-scanner-restart')
        showToast('تم اكتشاف تغيير في الشبكة. جاري تحديث اتصال الماسح تلقائيًا...', 'info')

        const nextState = await restartServer(status.server_port)
        if (cancelled) return

        setServerState({ ...nextState, pid: nextState.pid ?? null, error: nextState.error ?? null })
        await onRefresh({ ensureServer: false })
        await reloadDashboardData()
        if (!cancelled) {
          showToast('تم تحديث اتصال الماسح تلقائيًا. امسح QR جديد من شاشة الكاشير.', 'success')
        }
      } catch (error) {
        if (!cancelled) {
          showToast(
            error instanceof Error
              ? error.message
              : 'تعذر تحديث اتصال الماسح تلقائيًا. افتح تفاصيل السيرفر واضغط تحديث اتصال الماسح.',
            'error',
          )
        }
      } finally {
        scannerAutoRestartRef.current.inFlight = false
        if (!cancelled) setBusyAction(null)
      }
    }

    void watchLocalScannerEndpoint()
    const interval = window.setInterval(() => {
      void watchLocalScannerEndpoint()
    }, 5000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [onRefresh, reloadDashboardData, serverState.status, showToast, status.initialized, status.server_port])

  const updateStoreField = <K extends keyof StoreProfileFormState>(key: K, value: StoreProfileFormState[K]) => {
    setStoreForm((current) => ({ ...current, [key]: value }))
  }

  const copyToClipboard = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast(successMessage, 'success')
    } catch {
      showToast(TXT.copyFailed, 'error')
    }
  }

  const runServerAction = async (action: 'start' | 'stop' | 'restart') => {
    setBusyAction(action)
    setToast(null)
    try {
      const nextState: ServerState = action === 'start'
        ? await startServer(status.server_port)
        : action === 'restart'
          ? await restartServer(status.server_port)
          : await stopServer()

      setServerState({ ...nextState, pid: nextState.pid ?? null, error: nextState.error ?? null })
      if (action === 'stop') {
        setRuntimeHealth(null)
        showToast('\u062a\u0645 \u0625\u064a\u0642\u0627\u0641 \u0627\u0644\u0633\u064a\u0631\u0641\u0631.', 'success')
        return
      }
      await onRefresh({ ensureServer: false })
      await reloadDashboardData()
      showToast(action === 'restart' ? 'تم تحديث اتصال الماسح. امسح QR جديد من شاشة الكاشير.' : '\u062a\u0645 \u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0633\u064a\u0631\u0641\u0631.', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '\u062a\u0639\u0630\u0631 \u062a\u0646\u0641\u064a\u0630 \u0627\u0644\u0623\u0645\u0631.', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const handleBackup = async () => {
    setBusyAction('backup')
    setToast(null)
    try {
      const backupPath = await createBackup()
      showToast(backupPath ? `\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u0646\u0633\u062e\u0629 \u0627\u062d\u062a\u064a\u0627\u0637\u064a\u0629 \u0641\u064a: ${backupPath}` : '\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u0646\u0633\u062e\u0629 \u0627\u0644\u0627\u062d\u062a\u064a\u0627\u0637\u064a\u0629.', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '\u062a\u0639\u0630\u0631 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u0646\u0633\u062e\u0629 \u0627\u0644\u0627\u062d\u062a\u064a\u0627\u0637\u064a\u0629.', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const handleOpenLogoPicker = () => {
    setToast(null)
    openNativeFilePicker(logoInputRef.current)
  }

  const handleLogoFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0]
    event.target.value = ''
    if (!selectedFile) return
    try {
      const nextPreviewUrl = URL.createObjectURL(selectedFile)
      setDraftLogoPreviewUrl((current) => {
        if (current.startsWith('blob:')) URL.revokeObjectURL(current)
        return nextPreviewUrl
      })
      const savedPath = isTauriRuntime() ? await saveLogoFile(selectedFile) : selectedFile.name
      updateStoreField('logo_path', savedPath)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '\u062a\u0639\u0630\u0631 \u062d\u0641\u0638 \u0645\u0644\u0641 \u0627\u0644\u0634\u0639\u0627\u0631.', 'error')
    }
  }

  const handleStoreProfileSave = async () => {
    setBusyAction('store-profile')
    setToast(null)
    try {
      let logoPath = storeForm.logo_path.trim() || null
      if (logoPath && !isManagedLogoPath(logoPath)) {
        logoPath = await copyLogoToStoreAssets(logoPath)
      }

      await updateStoreProfile({
        store_name: storeForm.store_name.trim(),
        country: storeForm.country.trim(),
        currency: storeForm.currency.trim().toUpperCase(),
        store_type: storeForm.store_type,
        phone: storeForm.phone.trim() || null,
        address: storeForm.address.trim() || null,
        logo_path: logoPath,
      })

      if (logoPath) updateStoreField('logo_path', logoPath)
      await onRefresh({ ensureServer: false })
      await reloadDashboardData()
      setDraftLogoPreviewUrl((current) => {
        if (current.startsWith('blob:')) URL.revokeObjectURL(current)
        return ''
      })
      setActivePanel(null)
      showToast('\u062a\u0645 \u062d\u0641\u0638 \u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u062a\u062c\u0631 \u0628\u0646\u062c\u0627\u062d.', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '\u062a\u0639\u0630\u0631 \u062d\u0641\u0638 \u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u062a\u062c\u0631.', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const handleTelegramSave = async () => {
    if (!telegram) return
    setBusyAction('telegram')
    setToast(null)
    try {
      const next = await updateTelegramSettings({
        telegram_enabled: telegram.store_linked ? true : telegram.telegram_enabled,
        telegram_auto_send: telegram.telegram_auto_send,
        telegram_mode: telegram.telegram_mode,
      })
      setTelegram(next)
      await reloadDashboardData()
      showToast('\u062a\u0645 \u062d\u0641\u0638 \u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062a\u0644\u062c\u0631\u0627\u0645.', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '\u062a\u0639\u0630\u0631 \u062d\u0641\u0638 \u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062a\u0644\u062c\u0631\u0627\u0645.', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const handleTelegramTest = async () => {
    if (!selectedCustomerId) return
    setBusyAction('telegram-test')
    setToast(null)
    try {
      await sendTelegramTest(selectedCustomerId)
      showToast('\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0631\u0633\u0627\u0644\u0629 \u0627\u062e\u062a\u0628\u0627\u0631 \u0628\u0646\u062c\u0627\u062d.', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '\u062a\u0639\u0630\u0631 \u0625\u0631\u0633\u0627\u0644 \u0631\u0633\u0627\u0644\u0629 \u0627\u0644\u0627\u062e\u062a\u0628\u0627\u0631.', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <>
      <div className="launcher-dashboard">
        <section className="dashboard-hero launcher-card">
          <div className="dashboard-hero-brand">
            <img src={SYSTEM_LOGO_DARK_URL} alt={`\u0634\u0639\u0627\u0631 ${SYSTEM_BRAND_NAME}`} className="dashboard-brand-logo" />
            <p>{SYSTEM_BRAND_TAGLINE}</p>
          </div>
          <div className="dashboard-hero-divider" />
          <div className="dashboard-store-cluster">
            <div className="dashboard-store-icon">
              <img src={logoPreviewSrc} alt={'\u0634\u0639\u0627\u0631 \u0627\u0644\u0645\u062a\u062c\u0631'} />
            </div>
            <div className="dashboard-store-meta">
              <h1>{store?.store_name || TXT.noStoreName}</h1>
              <p>{`${formatStoreTypeLabel(store?.store_type)} ${'\u2022'} ${storeLocation}`}</p>
            </div>
            <div className="dashboard-badge-row">
              <span className="dashboard-badge host">{TXT.hostMode}</span>
              <span className="dashboard-badge license">
                {`\u0627\u0644\u062a\u0631\u062e\u064a\u0635: ${formatLicenseStatusLabel(license?.license_status)}`}
              </span>
            </div>
          </div>
        </section>

        <section className="dashboard-summary-grid">
          <article className="summary-card launcher-card motion-stagger-1">
            <CardTitle title={'\u0647\u0648\u064a\u0629 \u0627\u0644\u0645\u062a\u062c\u0631'} accent={<StoreIcon className="launcher-symbol small" />} />
            <div className="summary-store-body">
              <div className="summary-store-logo"><img src={logoPreviewSrc} alt={'\u0634\u0639\u0627\u0631 \u0627\u0644\u0645\u062a\u062c\u0631'} /></div>
              <div className="summary-store-copy">
                <h3>{store?.store_name || TXT.noStoreName}</h3>
                <p>{formatStoreTypeLabel(store?.store_type)}</p>
                <span>{storeLocation}</span>
              </div>
            </div>
            <button type="button" className="secondary wide-button" onClick={() => setActivePanel('store')}>{TXT.editStore}</button>
          </article>

          <article className="summary-card launcher-card license-summary-card motion-stagger-2">
            <CardTitle title={'\u0627\u0644\u062a\u0631\u062e\u064a\u0635'} accent={<ShieldIcon className="launcher-symbol small" />} />
            <div className="summary-kicker">{licenseTermLabel}</div>
            <div className="summary-stat-block">
              <span className="summary-highlight">{formatLicenseStatusLabel(license?.license_status)}</span>
              <LiveLicenseTicker license={license} />
              <p>{licenseDaysLabel}</p>
              <span className="summary-subtle-note">{`الاشتراك: ${licenseTermLabel} • ${licenseExpiryLabel === 'لا ينتهي' ? 'بدون انتهاء' : `ينتهي: ${licenseExpiryLabel}`}`}</span>
            </div>
            <button type="button" className="secondary wide-button" onClick={() => setActivePanel('license')}>{TXT.licenseDetails}</button>
          </article>

          <article className="summary-card launcher-card motion-stagger-3">
            <CardTitle title={'\u0627\u0644\u0633\u064a\u0631\u0641\u0631'} accent={<ServerIcon className="launcher-symbol small" />} />
            <div className="summary-card-spacer"><span className={`status-pill ${serverState.status}`}>{formatServerStateLabel(serverState.status)}</span></div>
            <div className="stacked-actions">
              <button type="button" className="secondary wide-button" onClick={() => void runServerAction('start')} disabled={busyAction !== null || serverIsRunning}>{'\u062a\u0634\u063a\u064a\u0644'}</button>
              {localHttpsRestartRequired ? (
                <button type="button" className="secondary wide-button" onClick={() => void runServerAction('restart')} disabled={busyAction !== null || !serverIsRunning}>تحديث اتصال الماسح</button>
              ) : null}
              <button type="button" className="secondary danger-soft wide-button" onClick={() => void runServerAction('stop')} disabled={busyAction !== null || !serverIsRunning}>{'\u0625\u064a\u0642\u0627\u0641'}</button>
              <button type="button" className="secondary wide-button" onClick={() => setActivePanel('server')}>{TXT.serverDetails}</button>
            </div>
          </article>

          <article className="summary-card launcher-card motion-stagger-4">
            <CardTitle title={'\u0627\u0644\u062a\u0644\u062c\u0631\u0627\u0645'} accent={<TelegramIcon className="launcher-symbol small" />} />
            <div className="telegram-mini-visual">
              <div className="telegram-orb">
                <TelegramIcon className="telegram-orb-icon" />
              </div>
            </div>
            <div className="summary-stat-block centered"><span className={`status-pill ${telegramStatus === TXT.linked ? 'running' : 'stopped'}`}>{telegramStatus}</span></div>
            <button type="button" className="secondary wide-button" onClick={() => setActivePanel('telegram')}>{TXT.manageTelegram}</button>
          </article>
        </section>

        <section className="quick-actions-panel launcher-card">
          <div className="quick-actions-header">
            <h2>{'\u0625\u062c\u0631\u0627\u0621\u0627\u062a \u0633\u0631\u064a\u0639\u0629'}</h2>
            <span className="summary-card-accent summary-card-icon-wrap"><PlayIcon className="launcher-symbol small" /></span>
          </div>
          <div className="quick-actions-grid">
            <ActionTile title={TXT.support} icon={<SupportIcon className="launcher-symbol" />} onClick={() => setActivePanel('support')} />
            <ActionTile title={TXT.backup} icon={<BackupIcon className="launcher-symbol" />} onClick={() => void handleBackup()} disabled={busyAction !== null} />
            <ActionTile title={TXT.copyClientLink} icon={<LinkIcon className="launcher-symbol" />} onClick={() => void copyToClipboard(networkInfo.desktop_url, '\u062a\u0645 \u0646\u0633\u062e \u0631\u0627\u0628\u0637 \u0627\u0644\u0639\u0645\u064a\u0644.')} />
            <ActionTile title={TXT.openSystem} icon={<PlayIcon className="launcher-symbol" />} primary onClick={() => void openExternal(serverState.url)} disabled={!serverIsRunning} />
          </div>
        </section>

        <footer className="dashboard-footer launcher-card">
          <button type="button" className="icon-ghost-button" onClick={() => setActivePanel('support')} aria-label={TXT.support}>?</button>
          <p>{`\u062c\u0645\u064a\u0639 \u0627\u0644\u062d\u0642\u0648\u0642 \u0645\u062d\u0641\u0648\u0638\u0629 (c) ${new Date().getFullYear()} ${SYSTEM_BRAND_NAME}`}</p>
          <button type="button" className="icon-ghost-button" onClick={() => setActivePanel('license')} aria-label={TXT.licenseDetails}>i</button>
        </footer>

      </div>
      <LauncherToast toast={toast} onClose={() => setToast(null)} />

      <input ref={logoInputRef} type="file" accept=".png,.jpg,.jpeg,.webp,.svg,.ico" className="sr-only-input" onChange={(event) => void handleLogoFileSelected(event)} tabIndex={-1} />

      {activePanel === 'store' ? (
        <Modal title={'\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u062a\u062c\u0631'} onClose={() => setActivePanel(null)}>
          <div className="store-profile-grid">
            <div className="store-logo-panel">
              <div className="store-logo-preview">
                {logoPreviewSrc ? <img src={logoPreviewSrc} alt={'\u0634\u0639\u0627\u0631 \u0627\u0644\u0645\u062a\u062c\u0631'} /> : <div className="store-logo-fallback"><img src={SYSTEM_LOGO_DARK_URL} alt={`\u0634\u0639\u0627\u0631 ${SYSTEM_BRAND_NAME}`} /></div>}
              </div>
              <div className="logo-path ltr-fragment">{storeForm.logo_path || TXT.noLogoYet}</div>
              <div className="button-row"><button type="button" className="secondary" onClick={handleOpenLogoPicker} disabled={busyAction !== null}>{TXT.chooseLogo}</button></div>
            </div>

            <div className="store-profile-fields">
              <label className="field"><span>{'\u0627\u0633\u0645 \u0627\u0644\u0645\u062a\u062c\u0631'}</span><input value={storeForm.store_name} onChange={(event) => updateStoreField('store_name', event.target.value)} /></label>
              <label className="field"><span>{'\u0627\u0644\u062f\u0648\u0644\u0629'}</span><input value={storeForm.country} onChange={(event) => updateStoreField('country', event.target.value)} /></label>
              <label className="field"><span>{'\u0627\u0644\u0639\u0645\u0644\u0629'}</span><input value={storeForm.currency} onChange={(event) => updateStoreField('currency', event.target.value.toUpperCase())} /></label>
              <label className="field"><span>{'\u0646\u0648\u0639 \u0627\u0644\u0645\u062a\u062c\u0631'}</span><select value={storeForm.store_type} onChange={(event) => updateStoreField('store_type', event.target.value as StoreType)}>{Object.entries(STORE_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="field"><span>{'\u0627\u0644\u0647\u0627\u062a\u0641'}</span><input value={storeForm.phone} onChange={(event) => updateStoreField('phone', event.target.value)} /></label>
              <label className="field"><span>{'\u0627\u0644\u0639\u0646\u0648\u0627\u0646'}</span><textarea rows={3} value={storeForm.address} onChange={(event) => updateStoreField('address', event.target.value)} /></label>
            </div>
          </div>

          <div className="info-box top-space">
            <strong>{'\u0627\u0642\u062a\u0631\u0627\u062d\u0627\u062a \u0627\u0644\u0623\u0642\u0633\u0627\u0645 \u062d\u0633\u0628 \u0646\u0648\u0639 \u0627\u0644\u0645\u062a\u062c\u0631'}</strong>
            <div className="suggestions">{categorySuggestions.length ? categorySuggestions.map((item) => <span key={item}>{item}</span>) : <span>{TXT.noSuggestions}</span>}</div>
          </div>

          {status.initialized && status.has_admin ? (
            <div className="info-box top-space">
              <strong>أمان حساب المدير</strong>
              <p>يمكنك استعادة حساب المدير باستخدام تلجرام المدير وسؤال الاستعادة.</p>
              <div className="button-row top-space">
                <button type="button" className="secondary" onClick={() => setActivePanel('recovery')}>
                  استعادة حساب المدير
                </button>
              </div>
            </div>
          ) : null}

          <div className="button-row top-space">
            <button type="button" onClick={() => void handleStoreProfileSave()} disabled={busyAction !== null}>{TXT.saveChanges}</button>
            <button type="button" className="secondary" onClick={() => setActivePanel(null)} disabled={busyAction !== null}>{TXT.cancel}</button>
          </div>
        </Modal>
      ) : null}

      {activePanel === 'recovery' ? (
        <AdminRecoveryModal
          status={recoveryStatus}
          onClose={() => setActivePanel('store')}
          onSuccess={reloadDashboardData}
          showToast={showToast}
        />
      ) : null}

      {activePanel === 'license' ? (
        <Modal title={'\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062a\u0631\u062e\u064a\u0635'} onClose={() => setActivePanel(null)}>
          <div className="modal-hero-strip">
            <div className="modal-hero-copy">
              <span className="modal-kicker">{formatLicenseStatusLabel(license?.license_status)}</span>
              <h4>{license?.license_type === 'trial' ? 'فترة تجريبية فعالة' : `اشتراك ${licenseTermLabel}`}</h4>
              <p>{licenseExpiryLabel === 'لا ينتهي' ? 'الاشتراك بدون انتهاء' : `الانتهاء: ${licenseExpiryLabel}`}</p>
            </div>
            <div className="modal-hero-badge">
              <span className={`status-pill ${license?.license_status === 'active' || license?.license_status === 'trial_active' ? 'running' : 'stopped'}`}>
                {formatLicenseStatusLabel(license?.license_status)}
              </span>
            </div>
          </div>
          <div className="modal-detail-grid">
            <section className="modal-detail-card">
              <div className="modal-section-title">{'\u0645\u0644\u062e\u0635 \u0627\u0644\u062a\u0631\u062e\u064a\u0635'}</div>
              <div className="detail-list">
                <KeyValue label={'نوع الترخيص'} value={license?.license_type || DASH} />
                <KeyValue label={'نوع الاشتراك'} value={licenseTermLabel} />
                <KeyValue label={'الخطة'} value={license?.plan || DASH} />
                <KeyValue label={'\u0628\u062f\u0621 \u0627\u0644\u062a\u062c\u0631\u0628\u0629'} value={formatDate(license?.trial_started_at)} />
                <KeyValue label={'\u0627\u0646\u062a\u0647\u0627\u0621 \u0627\u0644\u062a\u062c\u0631\u0628\u0629'} value={formatDate(license?.trial_expires_at)} />
                <KeyValue label={'\u0627\u0646\u062a\u0647\u0627\u0621 \u0627\u0644\u062a\u0631\u062e\u064a\u0635'} value={formatDate(license?.expires_at)} />
              </div>
            </section>
            <section className="modal-detail-card">
              <div className="modal-section-title">{'\u0645\u0639\u0631\u0641\u0627\u062a \u0627\u0644\u062a\u0641\u0639\u064a\u0644'}</div>
              <div className="detail-list">
                <KeyValue label={'\u0627\u0633\u0645 \u0627\u0644\u0645\u062a\u062c\u0631'} value={store?.store_name || DASH} />
                <KeyValue
                  label="store_id"
                  value={license?.store_id || store?.store_id || DASH}
                  ltr
                  action={
                    <button
                      type="button"
                      className="secondary"
                      style={{ paddingInline: '0.6rem', paddingBlock: '0.35rem', fontSize: '0.78rem' }}
                      onClick={() => void copyToClipboard(license?.store_id || store?.store_id || '', 'تم نسخ store_id.')}
                      disabled={!license?.store_id && !store?.store_id}
                    >
                      نسخ
                    </button>
                  }
                />
                <KeyValue
                  label="installation_id"
                  value={license?.installation_id || DASH}
                  ltr
                  action={
                    <button
                      type="button"
                      className="secondary"
                      style={{ paddingInline: '0.6rem', paddingBlock: '0.35rem', fontSize: '0.78rem' }}
                      onClick={() => void copyToClipboard(license?.installation_id || '', 'تم نسخ installation_id.')}
                      disabled={!license?.installation_id}
                    >
                      نسخ
                    </button>
                  }
                />
              </div>
            </section>
          </div>
          <div className="button-row top-space">
            <button
              type="button"
              onClick={() => {
                setActivePanel(null)
                onOpenLicenseGate()
              }}
            >
              {'\u0641\u062a\u062d \u0634\u0627\u0634\u0629 \u0627\u0644\u062a\u0641\u0639\u064a\u0644'}
            </button>
            <button type="button" className="secondary" onClick={() => license?.activation_request_url && void openExternal(license.activation_request_url)} disabled={!license?.activation_request_url}>{'\u0637\u0644\u0628 \u0627\u0644\u062a\u0641\u0639\u064a\u0644 \u0639\u0628\u0631 \u0648\u0627\u062a\u0633\u0627\u0628'}</button>
          </div>
        </Modal>
      ) : null}

      {activePanel === 'server' ? (
        <Modal title={'\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u0633\u064a\u0631\u0641\u0631'} onClose={() => setActivePanel(null)}>
          <div className="modal-hero-strip">
            <div className="modal-hero-copy">
              <span className="modal-kicker">{'\u062d\u0627\u0644\u0629 \u0627\u0644\u062a\u0634\u063a\u064a\u0644'}</span>
              <h4>{formatServerStateLabel(serverState.status)}</h4>
              <p>{serverState.error || '\u064a\u0645\u0643\u0646\u0643 \u0645\u0646 \u0647\u0646\u0627 \u0645\u0631\u0627\u062c\u0639\u0629 \u0631\u0648\u0627\u0628\u0637 \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u062a\u0634\u063a\u064a\u0644.'}</p>
            </div>
            <div className="modal-hero-badge">
              <span className={`status-pill ${serverState.status}`}>{formatServerStateLabel(serverState.status)}</span>
            </div>
          </div>
          <div className="modal-detail-grid">
            <section className="modal-detail-card">
              <div className="modal-section-title">{'\u0631\u0648\u0627\u0628\u0637 \u0627\u0644\u0648\u0635\u0648\u0644'}</div>
              <div className="detail-list">
                <KeyValue label={'\u0627\u0644\u0631\u0627\u0628\u0637 \u0627\u0644\u0645\u062d\u0644\u064a'} value={serverState.url} ltr />
                <KeyValue label={'\u0631\u0627\u0628\u0637 \u0627\u0644\u0648\u064a\u0628 \u0627\u0644\u062f\u0627\u062e\u0644\u064a'} value={networkInfo.desktop_url} ltr />
                <KeyValue label={'\u0631\u0627\u0628\u0637 \u0627\u0644\u0645\u0648\u0628\u0627\u064a\u0644 \u0627\u0644\u062f\u0627\u062e\u0644\u064a'} value={networkInfo.mobile_url} ltr />
                <KeyValue label={'\u0631\u0627\u0628\u0637 \u0627\u0644\u0645\u0648\u0628\u0627\u064a\u0644 \u0627\u0644\u0622\u0645\u0646'} value={publicMobileUrl || '\u063a\u064a\u0631 \u0645\u062a\u0627\u062d'} ltr />
              </div>
            </section>
            <section className="modal-detail-card">
              <div className="modal-section-title">{'\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u062a\u0634\u063a\u064a\u0644'}</div>
              <div className="detail-list">
                <KeyValue label={'\u0639\u0646\u0648\u0627\u0646 IP \u0627\u0644\u062f\u0627\u062e\u0644\u064a'} value={networkInfo.lan_ip} ltr />
                <KeyValue label="PID" value={serverState.pid || DASH} ltr />
                {localHttps?.status ? <KeyValue label={'\u062d\u0627\u0644\u0629 HTTPS \u0627\u0644\u0645\u062d\u0644\u064a'} value={localHttps.status} ltr /> : null}
                {localHttps?.lan_ip ? <KeyValue label={'IP \u0627\u0644\u0627\u062a\u0635\u0627\u0644 \u0627\u0644\u0622\u0645\u0646'} value={localHttps.lan_ip} ltr /> : null}
                {serverState.error ? <KeyValue label={'\u0631\u0633\u0627\u0644\u0629 \u0627\u0644\u062e\u0637\u0623'} value={serverState.error} /> : null}
              </div>
            </section>
          </div>
          {localHttpsIssue ? (
            <div className="info-box">
              <strong>رابط الماسح يحتاج تحديث</strong>
              <p>{localHttpsIssue}</p>
              {localHttpsRestartRequired ? (
                <button type="button" className="secondary top-space" onClick={() => void runServerAction('restart')} disabled={busyAction !== null || !serverIsRunning}>تحديث اتصال الماسح</button>
              ) : null}
            </div>
          ) : null}
          <div className="info-box top-space">
            <strong>تثبيت شهادة الماسح المحلي</strong>
            <div className="telegram-modal-grid top-space">
              {certificateInstallQr ? <img className="qr-code" src={certificateInstallQr} alt="QR تثبيت شهادة سريع" /> : <div className="qr-code qr-code-placeholder">جاري تجهيز QR الشهادة</div>}
              <div className="telegram-modal-side">
                <div className="info-box warning-box">
                  تنبيه أساسي: iPhone يستخدم Safari فقط، وAndroid يستخدم Google Chrome فقط. لا تستخدم Chrome على iPhone ولا المتصفح الداخلي للتطبيقات على Android.
                </div>
                <div className="info-box warning-box">
                  تنبيه iPhone: عند فتح QR قد تظهر رسالة أن الصفحة غير آمنة. اضغط إظهار التفاصيل ثم زيارة هذا الموقع مرة واحدة فقط حتى تظهر صفحة تنزيل شهادة سريع.
                </div>
                <div className="info-box warning-box">
                  لا تحذف شهادة سريع أو ملف الثقة من الموبايل بعد تفعيلها؛ حذفها سيعيد رسالة الاتصال غير الآمن وستحتاج لتثبيتها وتفعيلها من جديد.
                </div>
                <div className="mini-note">
                  هذا QR خاص بتثبيت شهادة الثقة فقط. QR الماسح من شاشة الكاشير يبقى رابط الماسح المباشر.
                </div>
                <div className="mini-note">
                  iPhone: اضغط زر تحميل ملف الثقة Profile من صفحة QR، ثم افتح Settings وستجد Install Profile أعلى الصفحة الرئيسية. بعد التثبيت اذهب إلى General → About → Certificate Trust Settings وفعّل Full Trust.
                </div>
                <div className="mini-note">
                  Android: استخدم Google Chrome لفتح رابط التثبيت والماسح، ثم ثبّت الشهادة كشهادة CA من إعدادات الأمان.
                </div>
                <div className="mini-note ltr-fragment">{certificateInstallUrl}</div>
              </div>
            </div>
          </div>
          <div className="button-row top-space">
            <button type="button" className="secondary" onClick={() => void openExternal(serverState.url)} disabled={!serverIsRunning}>{'\u0641\u062a\u062d \u0627\u0644\u0646\u0638\u0627\u0645'}</button>
            <button type="button" className="secondary" onClick={() => void reloadDashboardData()}>{'\u0625\u0639\u0627\u062f\u0629 \u0641\u062d\u0635 \u0627\u0644\u0633\u064a\u0631\u0641\u0631'}</button>
            <button type="button" className="secondary" onClick={() => void openExternal(certificateInstallUrl)} disabled={!certificateInstallUrl}>{'فتح صفحة تثبيت الشهادة'}</button>
            <button type="button" className="secondary" onClick={() => void copyToClipboard(certificateInstallUrl, 'تم نسخ رابط تثبيت الشهادة.')} disabled={!certificateInstallUrl}>{'نسخ رابط تثبيت الشهادة'}</button>
            <button type="button" className="secondary" onClick={() => void copyToClipboard(networkInfo.desktop_url, '\u062a\u0645 \u0646\u0633\u062e \u0631\u0627\u0628\u0637 \u0627\u0644\u0648\u064a\u0628.')}>{'\u0646\u0633\u062e \u0631\u0627\u0628\u0637 \u0627\u0644\u0648\u064a\u0628'}</button>
            <button type="button" className="secondary" onClick={() => void copyToClipboard(networkInfo.mobile_url, '\u062a\u0645 \u0646\u0633\u062e \u0631\u0627\u0628\u0637 \u0627\u0644\u0645\u0648\u0628\u0627\u064a\u0644 \u0627\u0644\u062f\u0627\u062e\u0644\u064a.')}>{'\u0646\u0633\u062e \u0631\u0627\u0628\u0637 \u0627\u0644\u0645\u0648\u0628\u0627\u064a\u0644 \u0627\u0644\u062f\u0627\u062e\u0644\u064a'}</button>
            <button type="button" className="secondary" onClick={() => publicMobileUrl && void copyToClipboard(publicMobileUrl, '\u062a\u0645 \u0646\u0633\u062e \u0631\u0627\u0628\u0637 \u0627\u0644\u0645\u0648\u0628\u0627\u064a\u0644.')} disabled={!publicMobileUrl}>{'\u0646\u0633\u062e \u0631\u0627\u0628\u0637 \u0627\u0644\u0645\u0648\u0628\u0627\u064a\u0644'}</button>
          </div>
        </Modal>
      ) : null}

      {activePanel === 'telegram' ? (
        <Modal title={'\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u062a\u0644\u062c\u0631\u0627\u0645'} onClose={() => setActivePanel(null)}>
          {telegram ? (
            <>
              <div className="modal-hero-strip telegram-modal-hero">
                <div className="modal-hero-copy">
                  <span className="modal-kicker">{'\u062d\u0627\u0644\u0629 \u0627\u0644\u062a\u0643\u0627\u0645\u0644'}</span>
                  <h4>{telegramStatus}</h4>
                  <p>{telegram.link ? '\u064a\u062a\u0645 \u062a\u0641\u0639\u064a\u0644 \u0627\u0644\u0645\u062a\u062c\u0631 \u062a\u0644\u0642\u0627\u0626\u064a\u064b\u0627 \u0628\u0639\u062f \u0641\u062a\u062d \u0631\u0627\u0628\u0637 \u0627\u0644\u0628\u0648\u062a \u0645\u0646 \u0627\u0644\u0645\u062f\u064a\u0631 \u0648\u0627\u0644\u0636\u063a\u0637 \u0639\u0644\u0649 Start.' : '\u0631\u0627\u0628\u0637 \u0627\u0644\u062a\u0641\u0639\u064a\u0644 \u063a\u064a\u0631 \u0645\u062a\u0627\u062d \u062d\u0627\u0644\u064a\u064b\u0627.'}</p>
                </div>
                <div className="modal-hero-badge telegram-hero-badge">
                  <div className="telegram-orb telegram-orb-large">
                    <TelegramIcon className="telegram-orb-icon telegram-orb-icon-large" />
                  </div>
                </div>
              </div>
              <div className="modal-detail-grid telegram-detail-grid">
                <section className="modal-detail-card">
                  <div className="modal-section-title">{'\u0631\u0628\u0637 \u0627\u0644\u0645\u062a\u062c\u0631 \u0648\u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a'}</div>
                  <div className="detail-list">
                    <KeyValue label={'\u0627\u0644\u062d\u0627\u0644\u0629'} value={telegramStatus} />
                    <KeyValue label={'\u0627\u0633\u0645 \u0627\u0644\u0628\u0648\u062a'} value={telegram.bot_username ? `@${telegram.bot_username}` : DASH} ltr />
                    <KeyValue label={'\u0631\u0627\u0628\u0637 \u0627\u0644\u062a\u0641\u0639\u064a\u0644'} value={telegram.link || DASH} ltr />
                    <KeyValue label={'\u062d\u0633\u0627\u0628 \u0627\u0644\u0631\u0628\u0637'} value={telegram.store_linked_username ? `@${telegram.store_linked_username}` : DASH} ltr />
                    <KeyValue label={'\u0648\u0642\u062a \u0627\u0644\u0631\u0628\u0637'} value={formatDate(telegram.store_linked_at)} />
                  </div>
                  <div className="toggle-grid compact">
                    <label><input type="checkbox" checked={telegram.telegram_auto_send} onChange={(event) => setTelegram((current) => (current ? { ...current, telegram_auto_send: event.target.checked } : current))} />{'\u0625\u0631\u0633\u0627\u0644 \u062a\u0644\u0642\u0627\u0626\u064a'}</label>
                    <label>{'\u0646\u0645\u0637 \u0627\u0644\u0625\u0631\u0633\u0627\u0644'}<select value={telegram.telegram_mode} onChange={(event) => setTelegram((current) => (current ? { ...current, telegram_mode: event.target.value as 'pdf' | 'text' } : current))}><option value="pdf">PDF</option><option value="text">{'\u0646\u0635\u064a'}</option></select></label>
                  </div>
                  <div className="info-box compact">
                    {'\u0627\u0641\u062a\u062d \u0631\u0627\u0628\u0637 \u0627\u0644\u0628\u0648\u062a \u0623\u0648 \u0627\u0645\u0633\u062d QR \u0645\u0646 \u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u062f\u064a\u0631\u060c \u062b\u0645 \u0627\u0636\u063a\u0637 Start. \u0633\u062a\u062a\u062d\u062f\u062b \u0627\u0644\u062d\u0627\u0644\u0629 \u0647\u0646\u0627 \u062a\u0644\u0642\u0627\u0626\u064a\u064b\u0627.'}
                  </div>
                  <div className="button-row">
                    <button type="button" onClick={() => void handleTelegramSave()} disabled={busyAction !== null}>{TXT.saveChanges}</button>
                    <button type="button" className="secondary" onClick={() => telegram.link && void openExternal(telegram.link)} disabled={!telegram.link}>{'\u0641\u062a\u062d \u0627\u0644\u0631\u0627\u0628\u0637'}</button>
                    <button type="button" className="secondary" onClick={() => telegram.link && void copyToClipboard(telegram.link, '\u062a\u0645 \u0646\u0633\u062e \u0631\u0627\u0628\u0637 \u0627\u0644\u062a\u0641\u0639\u064a\u0644.')} disabled={!telegram.link}>{'\u0646\u0633\u062e \u0627\u0644\u0631\u0627\u0628\u0637'}</button>
                  </div>
                </section>
                <section className="modal-detail-card">
                  <div className="modal-section-title">{'\u0631\u0628\u0637 \u0627\u0644\u0645\u062a\u062c\u0631 \u0648\u0627\u062e\u062a\u0628\u0627\u0631 \u0627\u0644\u0639\u0645\u0644\u0627\u0621'}</div>
                  <div className="telegram-modal-grid">
                    {telegramQr ? <img className="qr-code" src={telegramQr} alt={'QR'} /> : <div className="qr-code qr-code-placeholder">{'\u0644\u0627 \u064a\u0648\u062c\u062f QR \u062d\u0627\u0644\u064a\u064b\u0627'}</div>}
                    <div className="telegram-modal-side">
                      <div className="mini-note">{'\u0627\u0644\u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0645\u062c\u0627\u0648\u0631\u0629 \u0645\u062e\u0635\u0635\u0629 \u0644\u0644\u0639\u0645\u0644\u0627\u0621 \u0627\u0644\u0645\u0641\u0639\u0644\u064a\u0646 \u0644\u0627\u0633\u062a\u0644\u0627\u0645 \u0627\u0644\u0641\u0648\u0627\u062a\u064a\u0631\u060c \u0648\u0644\u064a\u0633\u062a \u0644\u062a\u0641\u0639\u064a\u0644 \u0627\u0644\u0645\u062a\u062c\u0631 \u0646\u0641\u0633\u0647.'}</div>
                      <div className="mini-note">{`\u0646\u0645\u0637 \u0627\u0644\u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u062d\u0627\u0644\u064a: ${formatTelegramModeLabel(telegram.telegram_mode)}`}</div>
                      <select value={selectedCustomerId || ''} onChange={(event) => setSelectedCustomerId(Number(event.target.value || 0) || null)} disabled={!activatedCustomers.length}>
                        {activatedCustomers.length ? activatedCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.customer_name || customer.phone_number}</option>) : <option value="">{'\u0644\u0627 \u064a\u0648\u062c\u062f \u0639\u0645\u0644\u0627\u0621 \u0645\u0641\u0639\u0644\u0648\u0646 \u062d\u0627\u0644\u064a\u064b\u0627'}</option>}
                      </select>
                      <button type="button" className="secondary" onClick={() => void handleTelegramTest()} disabled={!selectedCustomerId || busyAction !== null}>{'\u0625\u0631\u0633\u0627\u0644 \u0631\u0633\u0627\u0644\u0629 \u0627\u062e\u062a\u0628\u0627\u0631'}</button>
                    </div>
                  </div>
                </section>
              </div>
            </>
          ) : <p>{TXT.noTelegramSettings}</p>}
        </Modal>
      ) : null}

      {activePanel === 'support' ? (
        <Modal title={'\u0627\u0644\u062f\u0639\u0645 \u0627\u0644\u0641\u0646\u064a'} onClose={() => setActivePanel(null)}>
          <div className="modal-hero-strip">
            <div className="modal-hero-copy">
              <span className="modal-kicker">{'\u0642\u0646\u0648\u0627\u062a \u0627\u0644\u0645\u0633\u0627\u0639\u062f\u0629'}</span>
              <h4>{'\u0627\u0644\u062f\u0639\u0645 \u0627\u0644\u0641\u0646\u064a \u0648\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0646\u0638\u0627\u0645'}</h4>
              <p>{'\u0643\u0644 \u0645\u0627 \u062a\u062d\u062a\u0627\u062c\u0647 \u0644\u0644\u0648\u0635\u0648\u0644 \u0627\u0644\u0633\u0631\u064a\u0639 \u0644\u0644\u062f\u0639\u0645 \u0623\u0648 \u0645\u0631\u0627\u062c\u0639\u0629 \u0645\u0633\u0627\u0631\u0627\u062a \u0627\u0644\u0645\u0644\u0641\u0627\u062a.'}</p>
            </div>
          </div>
          <div className="modal-detail-grid">
            <section className="modal-detail-card">
              <div className="modal-section-title">{'\u0642\u0646\u0648\u0627\u062a \u0627\u0644\u062a\u0648\u0627\u0635\u0644'}</div>
              <div className="detail-list">
                <KeyValue label={'\u062a\u064a\u0644\u062c\u0631\u0627\u0645'} value="+970 569 38 3482" ltr />
                <KeyValue label={'\u0648\u0627\u062a\u0633\u0627\u0628'} value="+972 569 38 3482" ltr />
              </div>
            </section>
            <section className="modal-detail-card">
              <div className="modal-section-title">{'\u0645\u0633\u0627\u0631\u0627\u062a \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a'}</div>
              <div className="detail-list">
                <KeyValue label={'\u0645\u0633\u0627\u0631 \u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a'} value={paths.database_path || DASH} ltr />
                <KeyValue label={'\u0645\u062c\u0644\u062f \u0627\u0644\u0646\u0633\u062e'} value={paths.backups_dir || DASH} ltr />
              </div>
            </section>
          </div>
          <div className="button-row top-space">
            <button type="button" className="secondary" onClick={() => void openExternal('https://wa.me/972569383482')}>{'\u0641\u062a\u062d \u0648\u0627\u062a\u0633\u0627\u0628'}</button>
            <button type="button" className="secondary" onClick={() => void onResetMode()}>{'\u062a\u063a\u064a\u064a\u0631 \u0648\u0636\u0639 \u0627\u0644\u062c\u0647\u0627\u0632'}</button>
          </div>
        </Modal>
      ) : null}
    </>
  )
}

