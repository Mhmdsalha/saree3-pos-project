import { SYSTEM_BRAND_NAME, SYSTEM_BRAND_TAGLINE, SYSTEM_LOGO_DARK_URL } from '@/lib/system-branding'
import { ClientDeviceIcon, HostDeviceIcon } from '@/components/ui/launcher-icons'

type ModeSelectionPageProps = {
  installationId: string
  onSelectHost: () => Promise<void> | void
  onSelectClient: () => Promise<void> | void
}

export function ModeSelectionPage({
  installationId,
  onSelectHost,
  onSelectClient,
}: ModeSelectionPageProps) {
  return (
    <div className="launcher-mode-shell">
      <section className="launcher-card dashboard-hero mode-hero-card">
        <div className="dashboard-hero-brand">
          <img src={SYSTEM_LOGO_DARK_URL} alt={`شعار ${SYSTEM_BRAND_NAME}`} className="dashboard-brand-logo" />
          <p>{SYSTEM_BRAND_TAGLINE}</p>
        </div>
        <div className="dashboard-hero-divider" />
        <div className="mode-hero-copy">
          <div className="eyebrow">تهيئة الجهاز</div>
          <h1>اختر طريقة استخدام هذا الجهاز</h1>
          <p>يمكننا إعداد هذا الجهاز كجهاز رئيسي للمتجر، أو ربطه بمتجر موجود مسبقًا كجهاز عميل.</p>
          <span className="dashboard-badge host">{`معرّف التثبيت: ${installationId}`}</span>
        </div>
      </section>

      <section className="mode-selection-grid">
        <button type="button" className="mode-choice-card launcher-card" onClick={() => void onSelectHost()}>
          <div className="mode-choice-icon host">
            <HostDeviceIcon className="launcher-symbol" />
          </div>
          <div className="mode-choice-copy">
            <div className="mode-choice-kicker">Host Mode</div>
            <h2>إعداد متجر جديد على هذا الجهاز</h2>
            <p>هذا الجهاز سيصبح الجهاز الرئيسي للمخزن، وينشئ قاعدة البيانات، المدير الأول، ويشغّل السيرفر المحلي.</p>
          </div>
          <div className="mode-choice-points">
            <span>إعداد أولي كامل</span>
            <span>تشغيل السيرفر</span>
            <span>النسخ الاحتياطي والترخيص</span>
          </div>
        </button>

        <button type="button" className="mode-choice-card launcher-card" onClick={() => void onSelectClient()}>
          <div className="mode-choice-icon client">
            <ClientDeviceIcon className="launcher-symbol" />
          </div>
          <div className="mode-choice-copy">
            <div className="mode-choice-kicker">Client Mode</div>
            <h2>ربط هذا الجهاز بمتجر موجود</h2>
            <p>هذا المسار مناسب لأجهزة الكاشير أو الأجهزة الإضافية، حيث يتم الاتصال بالمضيف فقط بدون إنشاء قاعدة بيانات محلية.</p>
          </div>
          <div className="mode-choice-points">
            <span>اتصال بالمضيف فقط</span>
            <span>بدون إعداد متجر جديد</span>
            <span>جاهز لتسجيل الدخول والعمل</span>
          </div>
        </button>
      </section>
    </div>
  )
}
