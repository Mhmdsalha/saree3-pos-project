import { useState } from 'react'
import { activateLicense } from '@/lib/launcher-api'
import { LauncherToast, type LauncherToastState } from '@/components/ui/launcher-toast'
import { ShieldIcon, SupportIcon } from '@/components/ui/launcher-icons'
import { SYSTEM_BRAND_NAME } from '@/lib/system-branding'
import { openExternal } from '@/lib/tauri'
import type { LauncherStatus } from '@/types'

type LicenseGatePageProps = {
  status: LauncherStatus
  onActivated: () => Promise<void>
  onBack?: () => void
}

function formatExpiry(value?: string | null) {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatLicenseStatus(value?: string | null) {
  switch (value) {
    case 'trial_expired':
      return 'التجربة منتهية'
    case 'invalid':
      return 'غير صالح'
    case 'active':
      return 'مفعّل'
    case 'pending':
      return 'قيد الانتظار'
    default:
      return value || 'محجوب'
  }
}

function describeLicenseReason(statusReason?: string | null) {
  switch (statusReason) {
    case 'trial_expired':
      return 'انتهت الفترة التجريبية على هذا الجهاز، ويجب إدخال رمز تفعيل صالح للمتابعة.'
    case 'license_expired':
      return 'انتهى الاشتراك الحالي. أدخل رمز تجديد جديدًا لاستعادة الاستخدام.'
    case 'already_consumed':
      return 'هذا الرمز مستخدم مسبقًا، ولا يمكن استعماله مرة أخرى.'
    case 'sequence_older_than_current':
      return 'هذا الرمز أقدم من الترخيص الحالي، ويجب استخدام رمز أحدث.'
    case 'store_mismatch':
      return 'هذا الرمز مخصص لمتجر آخر، لذلك لن يعمل على هذا المتجر.'
    case 'installation_mismatch':
      return 'هذا الرمز مخصص لتثبيت آخر، ويجب إصدار رمز جديد لهذا الجهاز.'
    case 'clock_rollback_suspected':
      return 'تم رصد رجوع غير طبيعي في وقت الجهاز. صحح الوقت ثم أعد المحاولة.'
    case 'local_state_tampered':
      return 'تم رصد عبث في بيانات الترخيص المحلية. استخدم رمزًا جديدًا أو راجع الدعم.'
    default:
      return 'تم إيقاف الاستخدام العادي حتى يتم إدخال رمز تفعيل صالح لهذا المتجر وهذا التثبيت.'
  }
}

function CopyRow({
  label,
  value,
  copyValue,
  copyLabel,
  onCopy,
}: {
  label: string
  value?: string | null
  copyValue?: string | null
  copyLabel: string
  onCopy: (value: string, successMessage: string) => Promise<void>
}) {
  const resolvedValue = value || '—'
  const canCopy = Boolean(copyValue?.trim())

  return (
    <div className="detail-row detail-row-copyable">
      <div className="detail-row-main">
        <strong>{label}</strong>
        <span className="ltr-fragment">{resolvedValue}</span>
      </div>
      <button
        type="button"
        className="secondary"
        style={{ paddingInline: '0.75rem', paddingBlock: '0.45rem', fontSize: '0.82rem' }}
        onClick={() => void onCopy(String(copyValue || ''), copyLabel)}
        disabled={!canCopy}
      >
        نسخ
      </button>
    </div>
  )
}

export function LicenseGatePage({ status, onActivated, onBack }: LicenseGatePageProps) {
  const [activationKey, setActivationKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<LauncherToastState | null>(null)

  const license = status.license
  const store = status.store

  function showToast(text: string, tone: LauncherToastState['tone'] = 'info') {
    setToast({ text, tone })
  }

  async function copyToClipboard(value: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(value)
      showToast(successMessage, 'success')
    } catch {
      showToast('تعذر النسخ إلى الحافظة.', 'error')
    }
  }

  async function handleActivate() {
    if (!activationKey.trim()) {
      showToast('أدخل كود التفعيل أولًا.', 'error')
      return
    }

    setBusy(true)
    setToast(null)

    try {
      await activateLicense(activationKey.trim())
      setActivationKey('')
      showToast('تم تفعيل النظام بنجاح. سيتم تحديث الحالة الآن.', 'success')
      await onActivated()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'تعذر تفعيل النظام.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="dashboard-grid license-gate-grid">
        <section className="launcher-card hero-card license-hero-card">
          <div>
            <div className="eyebrow">{`${SYSTEM_BRAND_NAME} | التفعيل`}</div>
            <h1>التجربة منتهية أو أن الترخيص يحتاج إلى تفعيل</h1>
            <p>{describeLicenseReason(license?.status_reason || license?.reason)}</p>
          </div>
          <div className="license-hero-side">
            <div className="license-hero-icon">
              <ShieldIcon className="launcher-symbol" />
            </div>
            <div className="server-state error">{formatLicenseStatus(license?.license_status)}</div>
          </div>
        </section>

        <section className="launcher-card license-activation-card">
          <div className="summary-card-header">
            <span className="summary-card-title">بيانات التفعيل</span>
            <span className="summary-card-accent summary-card-icon-wrap">
              <ShieldIcon className="launcher-symbol small" />
            </span>
          </div>
          <div className="detail-list">
            <div>
              <strong>اسم المتجر:</strong> {store?.store_name || '—'}
            </div>
            <CopyRow
              label="store_id"
              value={license?.store_id || store?.store_id || '—'}
              copyValue={license?.store_id || store?.store_id || ''}
              copyLabel="تم نسخ store_id."
              onCopy={copyToClipboard}
            />
            <CopyRow
              label="installation_id"
              value={license?.installation_id || '—'}
              copyValue={license?.installation_id || ''}
              copyLabel="تم نسخ installation_id."
              onCopy={copyToClipboard}
            />
            <div>
              <strong>حالة الترخيص:</strong> {formatLicenseStatus(license?.license_status)}
            </div>
            <div>
              <strong>انتهاء التجربة:</strong> {formatExpiry(license?.trial_expires_at)}
            </div>
          </div>
          <div className="field">
            <span>كود التفعيل</span>
            <textarea
              className="license-key-area"
              rows={5}
              value={activationKey}
              onChange={(event) => setActivationKey(event.target.value)}
              placeholder="ألصق كود التفعيل المرسل لهذا المتجر وهذا الجهاز"
            />
          </div>
          <div className="button-row top-space">
            <button type="button" onClick={() => void handleActivate()} disabled={busy}>
              تفعيل النظام
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => license?.activation_request_url && void openExternal(license.activation_request_url)}
              disabled={!license?.activation_request_url}
            >
              طلب التفعيل عبر واتساب
            </button>
            {onBack ? (
              <button type="button" className="secondary" onClick={onBack} disabled={busy}>
                العودة للوحة الرئيسية
              </button>
            ) : null}
          </div>
        </section>

        <section className="launcher-card license-support-card">
          <div className="summary-card-header">
            <span className="summary-card-title">الدعم</span>
            <span className="summary-card-accent summary-card-icon-wrap">
              <SupportIcon className="launcher-symbol small" />
            </span>
          </div>
          <div className="detail-list">
            <div>
              <strong>تيليجرام:</strong> +970 569 38 3482
            </div>
            <div>
              <strong>واتساب:</strong> +972 569 38 3482
            </div>
            <div>
              <strong>الخطة:</strong> {license?.plan || '—'}
            </div>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              onClick={() => license?.activation_request_url && void openExternal(license.activation_request_url)}
              disabled={!license?.activation_request_url}
            >
              فتح واتساب
            </button>
          </div>
        </section>
      </div>
      <LauncherToast toast={toast} onClose={() => setToast(null)} />
    </>
  )
}
