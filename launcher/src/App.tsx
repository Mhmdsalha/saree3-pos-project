import { useCallback, useEffect, useRef, useState } from 'react'
import { loadLauncherStatus, loadRuntimeHealth, setLauncherApiOrigin } from '@/lib/launcher-api'
import {
  getLauncherConfig,
  getServerState,
  isTauriRuntime,
  resetHostStoreData,
  saveClientConnection,
  saveLauncherMode,
  startServer,
  stopServer,
} from '@/lib/tauri'
import { SYSTEM_BRAND_NAME, SYSTEM_LOGO_DARK_URL } from '@/lib/system-branding'
import { ClientDashboardPage } from '@/pages/client-dashboard-page'
import { DashboardPage } from '@/pages/dashboard-page'
import { ExistingHostDetectedPage } from '@/pages/existing-host-detected-page'
import { LicenseGatePage } from '@/pages/license-gate-page'
import { ModeSelectionPage } from '@/pages/mode-selection-page'
import { SetupWizard } from '@/pages/setup-wizard'
import type { LauncherConfig, LauncherStatus } from '@/types'

const READY_RETRY_COUNT = 20
const STARTUP_READY_RETRY_COUNT = 180
const READY_RETRY_DELAY_MS = 500
const MIN_SPLASH_MS = 1400
const FALLBACK_DASH = '-'
const STARTUP_MESSAGES = {
  initializing: '\u062c\u0627\u0631\u064a \u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0646\u0638\u0627\u0645',
  loadingConfig: '\u062a\u062d\u0645\u064a\u0644 \u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u0644\u0627\u0646\u0634\u0631',
  startingBackend: '\u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0633\u064a\u0631\u0641\u0631 \u0627\u0644\u0645\u062d\u0644\u064a',
  checkingHealth: '\u0641\u062d\u0635 \u062c\u0627\u0647\u0632\u064a\u0629 \u0627\u0644\u0633\u064a\u0631\u0641\u0631',
  loadingSystem: '\u062a\u062d\u0645\u064a\u0644 \u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u062a\u062c\u0631',
  ready: '\u062a\u062c\u0647\u064a\u0632 \u0644\u0648\u062d\u0629 \u0627\u0644\u062a\u062d\u0643\u0645',
} as const

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

type RefreshOptions = {
  ensureServer?: boolean
}

export default function App() {
  const [config, setConfig] = useState<LauncherConfig | null>(null)
  const [status, setStatus] = useState<LauncherStatus | null>(null)
  const [hostSelectionIntent, setHostSelectionIntent] = useState<'new_store' | null>(null)
  const [forceLicenseGate, setForceLicenseGate] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [startupMessage, setStartupMessage] = useState<string>(STARTUP_MESSAGES.initializing)
  const [splashLogoFailed, setSplashLogoFailed] = useState(false)
  const loadingStartedAtRef = useRef(Date.now())

  const beginLoading = useCallback((message: string = STARTUP_MESSAGES.initializing) => {
    loadingStartedAtRef.current = Date.now()
    setStartupMessage(message)
    setLoading(true)
  }, [])

  const finishLoading = useCallback(async () => {
    const elapsed = Date.now() - loadingStartedAtRef.current
    const remaining = Math.max(MIN_SPLASH_MS - elapsed, 0)
    if (remaining > 0) {
      await sleep(remaining)
    }
    setLoading(false)
  }, [])

  const refreshHost = useCallback(async ({ ensureServer = false }: RefreshOptions = {}) => {
    beginLoading()
    setError(null)

    try {
      if (isTauriRuntime()) {
        setStartupMessage(STARTUP_MESSAGES.startingBackend)
        let nextServerState = await getServerState()
        if (ensureServer) {
          nextServerState = await startServer(nextServerState.port)
        }
        setLauncherApiOrigin(`https://127.0.0.1:${nextServerState.port}`)

        if (nextServerState.status === 'error') {
          throw new Error(nextServerState.error || `تعذر تشغيل خدمة ${SYSTEM_BRAND_NAME}`)
        }

        if (nextServerState.status === 'stopped' && !ensureServer) {
          setStatus((current) => current)
          await finishLoading()
          return
        }

        setStartupMessage(STARTUP_MESSAGES.checkingHealth)
        try {
          await loadRuntimeHealth()
        } catch (healthError) {
          const runtimeState = await getServerState().catch(() => nextServerState)
          const runtimeMessage = runtimeState.error ? ` - ${runtimeState.error}` : ''
          throw healthError instanceof Error
            ? new Error(`${healthError.message}${runtimeMessage}`)
            : new Error(`\u062a\u0639\u0630\u0631 \u0641\u062d\u0635 \u062c\u0627\u0647\u0632\u064a\u0629 \u0627\u0644\u0633\u064a\u0631\u0641\u0631 \u0627\u0644\u0645\u062d\u0644\u064a${runtimeMessage}`)
        }

        setStartupMessage(STARTUP_MESSAGES.loadingSystem)
        let launcherStatus: LauncherStatus | null = null
        let lastError: unknown = null

        const retryCount = ensureServer ? STARTUP_READY_RETRY_COUNT : READY_RETRY_COUNT
        for (let attempt = 0; attempt < retryCount; attempt += 1) {
          try {
            launcherStatus = await loadLauncherStatus()
            break
          } catch (attemptError) {
            lastError = attemptError
            await sleep(READY_RETRY_DELAY_MS)
          }
        }

        if (!launcherStatus) {
          const runtimeState = await getServerState().catch(() => nextServerState)
          const runtimeMessage = runtimeState.error ? ` - ${runtimeState.error}` : ''
          throw lastError instanceof Error
            ? new Error(`${lastError.message}${runtimeMessage}`)
            : new Error(`تعذر انتظار جاهزية خدمة ${SYSTEM_BRAND_NAME}${runtimeMessage}`)
        }

        setStatus(launcherStatus)
        setForceLicenseGate(false)
        setStartupMessage(STARTUP_MESSAGES.ready)
        return
      }

      const next = await loadLauncherStatus()
      setStatus(next)
      setForceLicenseGate(false)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : `تعذر الاتصال بخدمات ${SYSTEM_BRAND_NAME}`)
    } finally {
      await finishLoading()
    }
  }, [beginLoading, finishLoading])

  const bootstrap = useCallback(async () => {
    beginLoading(STARTUP_MESSAGES.loadingConfig)
    setError(null)

    try {
      setStartupMessage(STARTUP_MESSAGES.loadingConfig)
      const nextConfig = await getLauncherConfig()
      setConfig(nextConfig)

      if (nextConfig.mode === 'host') {
        await refreshHost({ ensureServer: true })
        return
      }

      await finishLoading()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'تعذر تحميل إعدادات اللانشر')
      await finishLoading()
    }
  }, [beginLoading, finishLoading, refreshHost])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const handleSelectHost = useCallback(async () => {
    beginLoading()
    setError(null)
    setHostSelectionIntent('new_store')
    const nextConfig = await saveLauncherMode('host')
    setConfig(nextConfig)
    await refreshHost({ ensureServer: true })
  }, [beginLoading, refreshHost])

  const handleSelectClient = useCallback(async () => {
    beginLoading()
    setError(null)
    try {
      const nextConfig = await saveLauncherMode('client')
      setConfig(nextConfig)
      setStatus(null)
      setHostSelectionIntent(null)
      setForceLicenseGate(false)
    } finally {
      await finishLoading()
    }
  }, [beginLoading, finishLoading])

  const handleSaveClientConnection = useCallback(async (baseUrl: string) => {
    const nextConfig = await saveClientConnection(baseUrl)
    setConfig(nextConfig)
  }, [])

  const handleResetMode = useCallback(async () => {
    beginLoading()
    setError(null)
    try {
      if (config?.mode === 'host' && isTauriRuntime()) {
        await stopServer().catch(() => null)
      }
      const nextConfig = await saveLauncherMode(null)
      setConfig(nextConfig)
      setStatus(null)
      setHostSelectionIntent(null)
      setForceLicenseGate(false)
    } finally {
      await finishLoading()
    }
  }, [beginLoading, config?.mode, finishLoading])

  const handleOpenExistingHost = useCallback(async () => {
    setHostSelectionIntent(null)
  }, [])

  const handleStartFreshHost = useCallback(async () => {
    beginLoading()
    setError(null)
    try {
      await resetHostStoreData()
      setHostSelectionIntent(null)
      await refreshHost({ ensureServer: true })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'تعذر مسح بيانات الجهاز الحالية')
      await finishLoading()
    }
  }, [beginLoading, finishLoading, refreshHost])

  const handleSetupFinished = useCallback(async () => {
    setHostSelectionIntent(null)
    await refreshHost({ ensureServer: true })
  }, [refreshHost])

  return (
    <div className={loading ? 'app-shell app-shell-splash' : 'app-shell'} dir="rtl">
      {loading ? (
        <section className="launcher-splash-shell" aria-live="polite">
          <div className="launcher-splash-glow launcher-splash-glow-start" aria-hidden="true" />
          <div className="launcher-splash-glow launcher-splash-glow-end" aria-hidden="true" />
          <div className="launcher-splash-rings" aria-hidden="true" />
          <div className="launcher-splash">
            <div className="launcher-splash-content">
              <div className="launcher-splash-logo-wrap">
                {splashLogoFailed ? (
                  <div className="launcher-splash-logo-fallback" aria-label={`شعار ${SYSTEM_BRAND_NAME}`}>
                    {SYSTEM_BRAND_NAME}
                  </div>
                ) : (
                  <img
                    src={SYSTEM_LOGO_DARK_URL}
                    alt={`شعار ${SYSTEM_BRAND_NAME}`}
                    className="launcher-splash-logo"
                    onError={() => setSplashLogoFailed(true)}
                  />
                )}
              </div>
              <div className="launcher-splash-copy">
                <span className="launcher-splash-kicker">{SYSTEM_BRAND_NAME}</span>
                <p className="launcher-splash-status">{startupMessage}</p>
                <div className="launcher-splash-loader" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <div className="app-frame">
          {error ? (
          <div className="launcher-card centered-card error-state-card">
            <div className="error-state-visual">
              <div className="flow-badge large danger">!</div>
              <div className="error-state-glow" aria-hidden="true" />
            </div>
            <div className="error-state-copy">
              <span className="eyebrow">{`${SYSTEM_BRAND_NAME} | التشخيص`}</span>
              <h1>تعذر الوصول إلى النظام</h1>
              <p>{error}</p>
            </div>
            <div className="error-state-hints">
              <span>فحص الاتصال</span>
              <span>حالة السيرفر</span>
              <span>بيانات المتجر</span>
            </div>
            <div className="button-row centered-actions">
              <button type="button" onClick={() => void bootstrap()}>
                إعادة المحاولة
              </button>
              <button type="button" className="secondary" onClick={() => void handleResetMode()}>
                اختيار وضع الجهاز
              </button>
            </div>
          </div>
          ) : !config?.mode ? (
          <ModeSelectionPage
            installationId={config?.installation_id || FALLBACK_DASH}
            onSelectHost={handleSelectHost}
            onSelectClient={handleSelectClient}
          />
          ) : config.mode === 'client' ? (
          <ClientDashboardPage
            config={config}
            onSaveConnection={handleSaveClientConnection}
            onResetMode={handleResetMode}
          />
          ) : status?.initialized && hostSelectionIntent === 'new_store' ? (
          <ExistingHostDetectedPage
            status={status}
            onOpenExisting={handleOpenExistingHost}
            onStartFresh={handleStartFreshHost}
            onBack={handleResetMode}
          />
          ) : status?.initialized ? (
          status.license?.is_blocked || forceLicenseGate ? (
            <LicenseGatePage
              status={status}
              onActivated={() => refreshHost({ ensureServer: false })}
              onBack={status.license?.is_blocked ? undefined : () => setForceLicenseGate(false)}
            />
          ) : (
            <DashboardPage
              status={status}
              onRefresh={refreshHost}
              onResetMode={handleResetMode}
              onOpenLicenseGate={() => setForceLicenseGate(true)}
            />
          )
          ) : (
          <SetupWizard onFinished={handleSetupFinished} />
          )}
        </div>
      )}
    </div>
  )
}
