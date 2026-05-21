import { SYSTEM_BRAND_NAME } from '@/lib/system-branding'

import type { LauncherStatus } from '@/types'

type ExistingHostDetectedPageProps = {
  status: LauncherStatus
  onOpenExisting: () => Promise<void> | void
  onStartFresh: () => Promise<void> | void
  onBack: () => Promise<void> | void
}

export function ExistingHostDetectedPage({
  status,
  onOpenExisting,
  onStartFresh,
  onBack,
}: ExistingHostDetectedPageProps) {
  return (
    <div className="launcher-card">
      <div className="wizard-header">
        <div>
          <div className="eyebrow">{SYSTEM_BRAND_NAME} | وضع الاستضافة</div>
          <h1>يوجد متجر محفوظ مسبقًا على هذا الجهاز</h1>
          <p>
            إعادة تثبيت اللانشر لا تحذف بيانات المتجر المحلية تلقائيًا. لذلك قبل إنشاء متجر جديد، اختر ما إذا كنت تريد
            فتح المتجر الحالي أو مسح بيانات هذا الجهاز والبدء من جديد.
          </p>
        </div>
        <div className="step-pill">تم العثور على بيانات سابقة</div>
      </div>

      <div className="detail-list">
        <div><strong>اسم المتجر الحالي:</strong> {status.store?.store_name || '—'}</div>
        <div><strong>store_id:</strong> {status.store?.store_id || '—'}</div>
        <div><strong>الدولة:</strong> {status.store?.country || '—'}</div>
        <div><strong>العملة:</strong> {status.store?.currency || '—'}</div>
      </div>

      <div className="info-box">
        <strong>مهم</strong>
        <p>خيار البدء من جديد سيحذف قاعدة بيانات هذا الجهاز وملفات الشعار والتفعيل المحلي، لكنه لن يحذف النسخ الاحتياطية المحفوظة.</p>
      </div>

      <div className="button-row top-space">
        <button type="button" onClick={() => void onOpenExisting()}>
          فتح المتجر الحالي
        </button>
        <button type="button" className="secondary danger-outline" onClick={() => void onStartFresh()}>
          مسح بيانات هذا الجهاز والبدء بمتجر جديد
        </button>
        <button type="button" className="secondary" onClick={() => void onBack()}>
          رجوع
        </button>
      </div>
    </div>
  )
}

