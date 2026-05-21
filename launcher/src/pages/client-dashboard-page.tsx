import { useEffect, useMemo, useState } from 'react'
import { loadPublicStorefront, loadRemoteHealth } from '@/lib/launcher-api'
import { ClientDeviceIcon, LinkIcon, ShieldIcon, SupportIcon } from '@/components/ui/launcher-icons'
import { LauncherToast, type LauncherToastState } from '@/components/ui/launcher-toast'
import { SYSTEM_BRAND_NAME, SYSTEM_LOGO_DARK_URL } from '@/lib/system-branding'
import { openExternal } from '@/lib/tauri'
import type { LauncherConfig, RuntimeHealth, Storefront } from '@/types'

type ClientDashboardPageProps = {
  config: LauncherConfig
  onSaveConnection: (baseUrl: string) => Promise<void>
  onResetMode: () => Promise<void>
}

const STORE_TYPE_LABELS: Record<string, string> = {
  supermarket: 'سوبرماركت',
  clothing: 'ملابس',
  pharmacy: 'صيدلية',
  cosmetics: 'مستحضرات تجميل',
}

function formatConnectionState(hasStorefront: boolean, isBlocked: boolean) {
  if (isBlocked) return 'المضيف محجوب'
  if (hasStorefront) return 'متصل'
  return 'غير متصل'
}

function formatStoreType(value?: string | null) {
  if (!value) return '—'
  return STORE_TYPE_LABELS[value] || value
}

function formatLicenseState(value?: string | null) {
  switch (value) {
    case 'trial_active':
      return 'تجربة فعالة'
    case 'trial_expired':
      return 'التجربة منتهية'
    case 'active':
      return 'مفعل'
    case 'invalid':
      return 'غير صالح'
    case 'pending':
      return 'قيد الانتظار'
    default:
      return value || 'غير معروف'
  }
}

function normalizeBaseUrl(value: string) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  return `https://${trimmed}`
}

export function ClientDashboardPage({
  config,
  onSaveConnection,
  onResetMode,
}: ClientDashboardPageProps) {
  const [baseUrl, setBaseUrl] = useState(config.client_base_url || '')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<LauncherToastState | null>(null)
  const [storefront, setStorefront] = useState<Storefront | null>(null)
  const [health, setHealth] = useState<RuntimeHealth | null>(null)

  function showToast(text: string, tone: LauncherToastState['tone'] = 'info') {
    setToast({ text, tone })
  }

  useEffect(() => {
    setBaseUrl(config.client_base_url || '')
  }, [config.client_base_url])

  useEffect(() => {
    if (!config.client_base_url) return
    void testConnection(config.client_base_url, false)
  }, [config.client_base_url])

  const systemUrl = useMemo(() => {
    const normalized = normalizeBaseUrl(baseUrl || config.client_base_url || '')
    return normalized ? `${normalized}/frontend-react/` : ''
  }, [baseUrl, config.client_base_url])

  async function testConnection(targetUrl: string, announce = true) {
    const normalized = normalizeBaseUrl(targetUrl)
    if (!normalized) {
      showToast('أدخل رابط السيرفر المضيف أولًا.', 'error')
      return false
    }

    setBusy(true)
    setToast(null)

    try {
      const [nextStorefront, nextHealth] = await Promise.all([
        loadPublicStorefront(normalized),
        loadRemoteHealth(normalized),
      ])

      setStorefront(nextStorefront)
      setHealth(nextHealth)

      if (!nextStorefront.initialized) {
        showToast('تم الوصول للسيرفر، لكن المتجر على الجهاز المضيف غير مهيأ بعد.', 'info')
        return false
      }

      if (nextHealth.license?.is_blocked) {
        showToast('السيرفر المضيف متصل لكن الترخيص أو التجربة منتهية، لذلك النظام محجوب حاليًا.', 'error')
        return false
      }

      if (announce) {
        showToast('تم الاتصال بالسيرفر المضيف بنجاح.', 'success')
      }
      return true
    } catch (error) {
      setStorefront(null)
      setHealth(null)
      showToast(error instanceof Error ? error.message : 'تعذر الاتصال بالسيرفر المضيف.', 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleSave() {
    const ok = await testConnection(baseUrl, false)
    if (!ok) return
    await onSaveConnection(normalizeBaseUrl(baseUrl))
    showToast('تم حفظ عنوان السيرفر المضيف لهذا الجهاز.', 'success')
  }

  return (
    <>
      <div className="dashboard-grid">
        <section className="launcher-card hero-card client-hero-card">
          <div className="brand-stack">
            <div className="flow-badge flow-badge-symbol">
              <ClientDeviceIcon className="launcher-symbol" />
            </div>
            <div>
              <div className="eyebrow">{SYSTEM_BRAND_NAME} | وضع العميل</div>
              <h1>{storefront?.store_name || 'جهاز عميل'}</h1>
              <p>
                {formatStoreType(storefront?.store_type)} • {storefront?.country || '—'} • {storefront?.currency || '—'}
              </p>
            </div>
          </div>
          <div className={`server-state ${health?.license?.is_blocked ? 'error' : storefront ? 'running' : 'stopped'}`}>
            {formatConnectionState(Boolean(storefront), Boolean(health?.license?.is_blocked))}
          </div>
        </section>

        <section className="launcher-card">
          <div className="summary-card-header">
            <span className="summary-card-title">ربط الجهاز بالمتجر</span>
            <span className="summary-card-accent summary-card-icon-wrap"><LinkIcon className="launcher-symbol small" /></span>
          </div>
          <div className="detail-list">
            <div>أدخل عنوان الجهاز المضيف مثل `http://192.168.1.50:8000` أو أي رابط داخلي متاح داخل الشبكة.</div>
          </div>
          <div className="field">
            <span>رابط السيرفر المضيف</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://192.168.1.50:8000"
            />
          </div>
          <div className="button-row top-space">
            <button type="button" onClick={() => void testConnection(baseUrl)} disabled={busy}>
              اختبار الاتصال
            </button>
            <button type="button" className="secondary" onClick={() => void handleSave()} disabled={busy}>
              حفظ الاتصال
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => systemUrl && void openExternal(systemUrl)}
              disabled={!systemUrl || busy || !!health?.license?.is_blocked}
            >
              فتح النظام
            </button>
          </div>
        </section>

        <section className="launcher-card">
          <div className="summary-card-header">
            <span className="summary-card-title">حالة المضيف</span>
            <span className="summary-card-accent summary-card-icon-wrap"><ShieldIcon className="launcher-symbol small" /></span>
          </div>
          <div className="detail-list">
            <div><strong>الرابط المحفوظ:</strong> {config.client_base_url || 'غير محفوظ'}</div>
            <div><strong>حالة السيرفر:</strong> {health?.status || 'غير معروف'}</div>
            <div><strong>حالة الترخيص:</strong> {formatLicenseState(health?.license?.license_status)}</div>
            <div><strong>المتبقي من التجربة:</strong> {health?.license?.remaining_days ?? '—'}</div>
          </div>
        </section>

        <section className="launcher-card">
          <div className="summary-card-header">
            <span className="summary-card-title">الدعم</span>
            <span className="summary-card-accent summary-card-icon-wrap"><SupportIcon className="launcher-symbol small" /></span>
          </div>
          <div className="detail-list">
            <div><strong>تيليجرام:</strong> +970 569 38 3482</div>
            <div><strong>واتساب:</strong> +972 569 38 3482</div>
            <div><strong>معرّف التثبيت:</strong> {config.installation_id}</div>
          </div>
          <div className="button-row">
            <button type="button" className="secondary" onClick={() => void openExternal('https://wa.me/972569383482')}>
              فتح واتساب
            </button>
            <button type="button" className="secondary" onClick={() => void onResetMode()}>
              تغيير وضع الجهاز
            </button>
          </div>
        </section>
      </div>
      <LauncherToast toast={toast} onClose={() => setToast(null)} />
    </>
  )
}
