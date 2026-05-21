import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  loadCategorySuggestions,
  loadManagerTelegramSetupStatus,
  loadNetworkInfo,
  runLauncherSetup,
  startManagerTelegramSetupLink,
} from '@/lib/launcher-api'
import { LauncherToast, type LauncherToastState } from '@/components/ui/launcher-toast'
import { SYSTEM_BRAND_NAME } from '@/lib/system-branding'
import { copyLogoToStoreAssets, isTauriRuntime, openExternal, saveLogoFile } from '@/lib/tauri'
import type { ManagerTelegramSetupStatus, SetupPayload, StoreType } from '@/types'

type SetupWizardProps = {
  onFinished: () => Promise<void> | void
}

const COUNTRY_CURRENCY_MAP: Record<string, string> = {
  palestine: 'ILS',
  israel: 'ILS',
  jordan: 'JOD',
  saudi: 'SAR',
  egypt: 'EGP',
  uae: 'AED',
}

const STORE_TYPE_LABELS: Record<StoreType, string> = {
  supermarket: 'سوبرماركت',
  clothing: 'ملابس',
  pharmacy: 'صيدلية',
  cosmetics: 'مستحضرات تجميل',
}

const SETUP_STEPS = 6

function buildCertificateInstallUrl(mobileUrl: string) {
  const origin = String(mobileUrl || '').replace(/\/mobile-react\/?$/i, '').replace(/\/$/, '')
  return `${origin}/install-ca?cert_only=true`
}

export function SetupWizard({ onFinished }: SetupWizardProps) {
  const logoInputRef = useRef<HTMLInputElement | null>(null)
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<LauncherToastState | null>(null)
  const [categorySuggestions, setCategorySuggestions] = useState<string[]>([])
  const [managerTelegram, setManagerTelegram] = useState<ManagerTelegramSetupStatus | null>(null)
  const [managerTelegramQr, setManagerTelegramQr] = useState('')
  const [certificateInstallUrl, setCertificateInstallUrl] = useState('')
  const [certificateInstallQr, setCertificateInstallQr] = useState('')
  const [telegramLinkLoading, setTelegramLinkLoading] = useState(false)
  const [form, setForm] = useState<SetupPayload>({
    store_name: '',
    country: 'Palestine',
    currency: 'ILS',
    store_type: 'supermarket',
    phone: '',
    address: '',
    logo_path: '',
    server_port: 8000,
    admin_name: '',
    admin_username: '',
    admin_password: '',
    secret_question: '',
    secret_answer: '',
    secret_answer_confirm: '',
  })

  function showToast(text: string, tone: LauncherToastState['tone'] = 'info') {
    setToast({ text, tone })
  }

  useEffect(() => {
    const suggested = COUNTRY_CURRENCY_MAP[form.country.trim().toLowerCase()]
    if (suggested) {
      setForm((current) => ({ ...current, currency: suggested }))
    }
  }, [form.country])

  useEffect(() => {
    void loadCategorySuggestions(form.store_type)
      .then((payload) => setCategorySuggestions(payload.suggestions))
      .catch(() => setCategorySuggestions([]))
  }, [form.store_type])

  const canProceedStore = useMemo(
    () => Boolean(form.store_name.trim() && form.country.trim() && form.currency.trim()),
    [form.country, form.currency, form.store_name],
  )
  const canProceedSystem = useMemo(() => Boolean(form.server_port && form.server_port > 0), [form.server_port])
  const canProceedAdmin = useMemo(
    () => Boolean(form.admin_name.trim() && form.admin_username.trim() && (form.admin_password || '').length >= 8),
    [form.admin_name, form.admin_password, form.admin_username],
  )
  const canProceedTelegram = Boolean(managerTelegram?.linked)
  const canSubmit = useMemo(
    () => Boolean(form.secret_question.trim() && form.secret_answer.trim() && form.secret_answer === form.secret_answer_confirm),
    [form.secret_answer, form.secret_answer_confirm, form.secret_question],
  )

  const updateField = <K extends keyof SetupPayload>(key: K, value: SetupPayload[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handlePickLogo = () => {
    setToast(null)
    const input = logoInputRef.current as (HTMLInputElement & { showPicker?: () => void }) | null
    if (!input) return

    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker()
        return
      }
      input.click()
    } catch (nextError) {
      showToast(nextError instanceof Error ? nextError.message : 'تعذر فتح نافذة اختيار شعار المتجر', 'error')
    }
  }

  const handleLogoFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0]
    event.target.value = ''
    if (!selectedFile) return

    try {
      const savedPath = isTauriRuntime() ? await saveLogoFile(selectedFile) : selectedFile.name
      updateField('logo_path', savedPath)
      showToast('تم اختيار شعار المتجر بنجاح.', 'success')
    } catch (nextError) {
      showToast(nextError instanceof Error ? nextError.message : 'تعذر اختيار ملف الشعار', 'error')
    }
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    setToast(null)

    try {
      let logoPath = form.logo_path?.trim() || null
      if (logoPath && !logoPath.includes('\\uploads\\logo\\') && !logoPath.includes('/uploads/logo/')) {
        logoPath = await copyLogoToStoreAssets(logoPath)
      }

      await runLauncherSetup({
        ...form,
        phone: form.phone?.trim() || null,
        address: form.address?.trim() || null,
        logo_path: logoPath,
      })

      await onFinished()
    } catch (nextError) {
      showToast(nextError instanceof Error ? nextError.message : 'تعذر إكمال الإعداد الأولي', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const ensureManagerTelegramLink = async () => {
    try {
      setTelegramLinkLoading(true)
      const next = await startManagerTelegramSetupLink()
      setManagerTelegram(next)
      if (!next.bot_token_configured) {
        showToast('سيظهر QR، لكن الربط لن يكتمل حتى يكون TELEGRAM_BOT_TOKEN موجودًا في النسخة.', 'error')
      } else if (!next.bot_username) {
        showToast('يجب إعداد بوت تلجرام قبل ربط تلجرام المدير.', 'error')
      }
    } catch (nextError) {
      showToast(nextError instanceof Error ? nextError.message : 'تعذر إنشاء رابط تلجرام المدير.', 'error')
    } finally {
      setTelegramLinkLoading(false)
    }
  }

  useEffect(() => {
    if (step !== 3) return
    void loadNetworkInfo()
      .then((network) => setCertificateInstallUrl(buildCertificateInstallUrl(network.mobile_url)))
      .catch(() => setCertificateInstallUrl(buildCertificateInstallUrl(`https://127.0.0.1:${form.server_port || 8000}/mobile-react/`)))
  }, [form.server_port, step])

  useEffect(() => {
    if (!certificateInstallUrl) {
      setCertificateInstallQr('')
      return
    }
    void QRCode.toDataURL(certificateInstallUrl, { width: 180, margin: 1 }).then(setCertificateInstallQr).catch(() => setCertificateInstallQr(''))
  }, [certificateInstallUrl])

  useEffect(() => {
    if (step !== 5) return
    void ensureManagerTelegramLink()
    const interval = window.setInterval(() => {
      void loadManagerTelegramSetupStatus().then(setManagerTelegram).catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(interval)
  }, [step])

  useEffect(() => {
    if (!managerTelegram?.link) {
      setManagerTelegramQr('')
      return
    }
    void QRCode.toDataURL(managerTelegram.link, { width: 180, margin: 1 }).then(setManagerTelegramQr).catch(() => setManagerTelegramQr(''))
  }, [managerTelegram?.link])

  return (
    <>
      <div className="launcher-card">
        <div className="wizard-header">
          <div>
            <div className="eyebrow">{SYSTEM_BRAND_NAME} | الإعداد الأولي</div>
            <h1>تهيئة المتجر لأول مرة</h1>
            <p>سننشئ قاعدة بيانات فارغة، ملف المتجر، شهادة الاتصال المحلي، وحساب المدير الأول بشكل آمن.</p>
          </div>
          <div className="wizard-progress-cluster">
            <div className="step-pill">الخطوة {step} من {SETUP_STEPS}</div>
            <div className="wizard-stage-dots" aria-hidden="true">
              {Array.from({ length: SETUP_STEPS }, (_, index) => (
                <span key={index} className={step >= index + 1 ? 'active' : ''} />
              ))}
            </div>
          </div>
        </div>

        {step === 1 ? (
          <div className="wizard-grid wizard-grid-stage">
            <Field label="اسم المتجر">
              <input value={form.store_name} onChange={(event) => updateField('store_name', event.target.value)} />
            </Field>
            <Field label="الدولة">
              <input value={form.country} onChange={(event) => updateField('country', event.target.value)} />
            </Field>
            <Field label="العملة">
              <input value={form.currency} onChange={(event) => updateField('currency', event.target.value.toUpperCase())} />
            </Field>
            <Field label="نوع المتجر">
              <select value={form.store_type} onChange={(event) => updateField('store_type', event.target.value as StoreType)}>
                {Object.entries(STORE_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="الهاتف">
              <input value={form.phone || ''} onChange={(event) => updateField('phone', event.target.value)} />
            </Field>
            <Field label="العنوان">
              <textarea value={form.address || ''} onChange={(event) => updateField('address', event.target.value)} rows={3} />
            </Field>
            <Field label="مسار الشعار">
              <div className="file-picker-row">
                <input
                  ref={logoInputRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,.svg,.ico"
                  className="sr-only-input"
                  onChange={(event) => void handleLogoFileSelected(event)}
                  tabIndex={-1}
                />
                <input
                  value={form.logo_path || ''}
                  onChange={(event) => updateField('logo_path', event.target.value)}
                  placeholder="اختر مسار ملف الشعار وسيتم نسخه إلى مجلد المتجر"
                />
                <button type="button" className="secondary" onClick={handlePickLogo}>
                  اختيار من الملفات
                </button>
              </div>
            </Field>
            <div className="info-box full-width">
              <strong>اقتراحات الأقسام حسب نوع المتجر</strong>
              <div className="suggestions">
                {categorySuggestions.length ? categorySuggestions.map((item) => <span key={item}>{item}</span>) : <span>لا توجد اقتراحات حالية</span>}
              </div>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="wizard-grid compact wizard-grid-stage">
            <Field label="منفذ السيرفر المحلي">
              <input
                type="number"
                min={1}
                max={65535}
                value={form.server_port || 8000}
                onChange={(event) => updateField('server_port', Number(event.target.value || 8000))}
              />
            </Field>
            <div className="info-box full-width">
              <strong>ملاحظة</strong>
              <p>المنفذ سيستخدم لتشغيل واجهة النظام محليًا من اللانشر. القيمة الافتراضية الموصى بها هي 8000.</p>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="wizard-grid certificate-step-grid wizard-grid-stage">
            <div className="info-box full-width">
              <strong>إعداد شهادة الماسح المحلي</strong>
              <p>امسح هذا الرمز من الموبايل مرة واحدة لتثبيت شهادة الثقة. بعدها سيعمل ماسح سريع على الشبكة المحلية عبر HTTPS بدون ngrok وبدون إنترنت.</p>
            </div>
            <div className="certificate-alert-grid full-width">
              <div className="info-box warning-box">
                <strong>تنبيه أساسي</strong>
                <p>iPhone يستخدم Safari فقط، وAndroid يستخدم Google Chrome فقط.</p>
              </div>
              <div className="info-box warning-box">
                <strong>iPhone</strong>
                <p>لا تستخدم Chrome على iPhone. إذا ظهرت رسالة أن الصفحة غير آمنة في Safari، اضغط إظهار التفاصيل ثم زيارة هذا الموقع.</p>
              </div>
              <div className="info-box warning-box">
                <strong>الشهادة</strong>
                <p>لا تحذف شهادة سريع أو ملف الثقة من الموبايل بعد تفعيلها حتى لا تظهر رسالة الاتصال غير الآمن من جديد.</p>
              </div>
            </div>
            <div className="telegram-modal-grid certificate-qr-layout full-width">
              {certificateInstallQr ? <img className="qr-code" src={certificateInstallQr} alt="QR تثبيت شهادة سريع" /> : <div className="qr-code qr-code-placeholder">جاري تجهيز QR الشهادة</div>}
              <div className="telegram-modal-side">
                <div className="mini-note">
                  iPhone: افتح الرابط من Safari، ثم اضغط زر تحميل ملف الثقة Profile من صفحة QR، ثم افتح Settings وستجد Install Profile أعلى الصفحة الرئيسية. ثبّت الملف، وبعدها اذهب إلى General → About → Certificate Trust Settings وفعّل Full Trust. لا تفتح الماسح قبل تفعيل الثقة.
                </div>
                <div className="mini-note">
                  Android: استخدم Google Chrome لفتح رابط التثبيت والماسح، ولا تستخدم المتصفح الداخلي للتطبيقات. بعد التحميل ثبّت الشهادة كشهادة CA من إعدادات الأمان.
                </div>
                <div className="mini-note ltr-fragment">{certificateInstallUrl || 'رابط شهادة الاتصال غير جاهز حاليًا'}</div>
                <div className="button-row">
                  <button type="button" className="secondary" onClick={() => certificateInstallUrl && void openExternal(certificateInstallUrl)} disabled={!certificateInstallUrl}>
                    فتح صفحة تثبيت الشهادة
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="wizard-grid compact wizard-grid-stage">
            <Field label="اسم المدير الكامل">
              <input value={form.admin_name} onChange={(event) => updateField('admin_name', event.target.value)} />
            </Field>
            <Field label="اسم المستخدم / البريد">
              <input value={form.admin_username} onChange={(event) => updateField('admin_username', event.target.value)} />
            </Field>
            <Field label="كلمة المرور">
              <input type="password" value={form.admin_password} onChange={(event) => updateField('admin_password', event.target.value)} />
            </Field>
            <div className="info-box full-width">
              <strong>سيتم إنشاؤه الآن</strong>
              <ul className="compact-list">
                <li>قاعدة بيانات فارغة</li>
                <li>ملف المتجر وهوية سريع</li>
                <li>حساب المدير الأول</li>
              </ul>
            </div>
          </div>
        ) : null}

        {step === 5 ? (
          <div className="wizard-grid compact wizard-grid-stage">
            <div className="info-box full-width">
              <strong>تلجرام المدير</strong>
              <p>سيتم استخدام تلجرام المدير مع سؤال الاستعادة لحماية حساب المدير واستعادته عند نسيان بيانات الدخول.</p>
            </div>
            <div className="info-box full-width">
              <strong>{managerTelegram?.linked ? 'تم ربط تلجرام المدير' : 'اربط حساب المدير الآن'}</strong>
              <p>{managerTelegram?.manager_telegram_masked || 'افتح الرابط من حساب المدير في تلجرام ثم اضغط Start.'}</p>
              {managerTelegram && !managerTelegram.bot_token_configured ? (
                <div className="info-box warning-box">
                  QR ظاهر، لكن استقبال ضغط Start يحتاج توكن البوت داخل النسخة. أعد بناء النسخة مع إعدادات تلجرام أو تحقق من TELEGRAM_BOT_TOKEN.
                </div>
              ) : null}
              <div className="telegram-modal-grid top-space">
                {managerTelegramQr ? <img className="qr-code" src={managerTelegramQr} alt="QR تلجرام المدير" /> : <div className="qr-code qr-code-placeholder">لا يوجد QR حاليًا</div>}
                <div className="telegram-modal-side">
                  <div className="mini-note">يمكن فتح الرابط من نفس الجهاز أو مسح QR من موبايل المدير لربط الحساب بسرعة.</div>
                  <div className="mini-note ltr-fragment">{managerTelegram?.link || 'رابط الربط غير متاح حاليًا'}</div>
                </div>
              </div>
              <div className="button-row top-space">
                <button type="button" onClick={() => managerTelegram?.link && void openExternal(managerTelegram.link)} disabled={!managerTelegram?.link}>
                  فتح رابط تلجرام المدير
                </button>
                <button type="button" className="secondary" onClick={() => void ensureManagerTelegramLink()} disabled={telegramLinkLoading}>
                  {telegramLinkLoading ? 'جارٍ التجهيز...' : 'تحديث حالة الربط'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {step === 6 ? (
          <div className="wizard-grid compact wizard-grid-stage">
            <div className="info-box full-width">
              <strong>سؤال استعادة حساب المدير</strong>
              <p>سيتم استخدام تلجرام المدير مع سؤال الاستعادة لاستعادة حساب المدير عند نسيان بيانات الدخول.</p>
            </div>
            <Field label="سؤال استعادة الحساب">
              <input value={form.secret_question} onChange={(event) => updateField('secret_question', event.target.value)} />
            </Field>
            <Field label="إجابة الاستعادة">
              <input type="password" value={form.secret_answer} onChange={(event) => updateField('secret_answer', event.target.value)} />
            </Field>
            <Field label="تأكيد إجابة الاستعادة">
              <input type="password" value={form.secret_answer_confirm} onChange={(event) => updateField('secret_answer_confirm', event.target.value)} />
            </Field>
          </div>
        ) : null}

        <div className="wizard-actions">
          <button type="button" className="secondary" disabled={step === 1 || submitting} onClick={() => setStep((current) => current - 1)}>
            السابق
          </button>
          {step < SETUP_STEPS ? (
            <button
              type="button"
              disabled={
                (step === 1 && !canProceedStore) ||
                (step === 2 && !canProceedSystem) ||
                (step === 4 && !canProceedAdmin) ||
                (step === 5 && !canProceedTelegram) ||
                submitting
              }
              onClick={() => setStep((current) => current + 1)}
            >
              التالي
            </button>
          ) : (
            <button type="button" disabled={!canSubmit || submitting} onClick={() => void handleSubmit()}>
              {submitting ? 'جارٍ الإعداد...' : 'إكمال التهيئة'}
            </button>
          )}
        </div>
      </div>
      <LauncherToast toast={toast} onClose={() => setToast(null)} />
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}
