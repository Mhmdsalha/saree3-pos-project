import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

type ShortcutGroup = {
  title: string
  shortcuts: Array<{ key: string; description: string; scope: string }>
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: 'اختصارات الكاشير',
    shortcuts: [
      { key: 'F1', description: 'فتح صفحة الاختصارات', scope: 'كل النظام' },
      { key: 'F2', description: 'تركيز البحث عن المنتجات', scope: 'الكاشير' },
      { key: 'F3', description: 'فتح الدفع وتركيز اسم العميل', scope: 'الكاشير' },
      { key: 'F4', description: 'فتح نافذة الدفع', scope: 'الكاشير' },
      { key: 'F6', description: 'التبديل بين تبويبات المنتجات', scope: 'الكاشير' },
      { key: 'F7', description: 'إرسال آخر فاتورة PDF عبر تيليجرام', scope: 'الكاشير' },
      { key: 'F8', description: 'إلغاء الفاتورة الحالية', scope: 'الكاشير' },
      { key: 'F9', description: 'طباعة آخر فاتورة محفوظة', scope: 'الكاشير' },
      { key: 'F10', description: 'تعليق الحالية وفتح فاتورة جديدة', scope: 'الكاشير' },
      { key: 'Arrow Up / Down', description: 'التنقل بين منتجات التبويب الحالي', scope: 'الكاشير' },
      { key: 'Enter', description: 'إضافة المنتج المحدد أو تأكيد النافذة الحالية', scope: 'الكاشير' },
      { key: '+ / -', description: 'زيادة أو إنقاص كمية السطر المحدد', scope: 'الفاتورة' },
      { key: 'Delete / Ctrl+Backspace', description: 'حذف السطر المحدد بأمان', scope: 'الفاتورة' },
      { key: 'Esc', description: 'إغلاق النافذة الحالية', scope: 'النوافذ' },
    ],
  },
  {
    title: 'اختصارات عامة',
    shortcuts: [
      { key: 'Ctrl + F', description: 'تركيز حقل البحث في الصفحة الحالية', scope: 'الصفحات الداعمة' },
      { key: 'Ctrl + S', description: 'حفظ النموذج الحالي عند توفره', scope: 'إعداد الصنف / النوافذ' },
      { key: 'Ctrl + E', description: 'تعديل الصنف المحدد في صفحة المنتجات', scope: 'المنتجات' },
      { key: 'Ctrl + R', description: 'تحديث البيانات الحالية بأمان', scope: 'كل النظام' },
      { key: 'Ctrl + T', description: 'تشغيل إجراء تيليجرام عند ملاءمته', scope: 'الدفع' },
    ],
  },
]

type ShortcutsPageProps = {
  onBack?: () => void
}

export function ShortcutsPage({ onBack }: ShortcutsPageProps) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-3xl font-black">اختصارات النظام</div>
          <div className="mt-1 text-sm text-[var(--text-muted)]">مرجع سريع لأهم اختصارات الكيبورد المستخدمة يوميًا داخل النظام.</div>
        </div>
        {onBack ? (
          <Button type="button" variant="secondary" onClick={onBack}>
            رجوع
          </Button>
        ) : null}
      </div>

      <div className="grid gap-4">
        {shortcutGroups.map((group) => (
          <Card key={group.title} className="rounded-[24px] p-0 shadow-none">
            <div className="border-b border-[var(--line)] px-5 py-4">
              <div className="text-lg font-black">{group.title}</div>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-right">
                <thead className="bg-[var(--muted)] text-sm">
                  <tr className="border-b border-[var(--line)]">
                    <th className="px-4 py-3">الاختصار</th>
                    <th className="px-4 py-3">الوصف</th>
                    <th className="px-4 py-3">المجال</th>
                  </tr>
                </thead>
                <tbody>
                  {group.shortcuts.map((shortcut) => (
                    <tr key={`${group.title}-${shortcut.key}`} className="border-b border-[var(--line)] text-sm last:border-b-0">
                      <td className="px-4 py-3 font-mono font-bold">{shortcut.key}</td>
                      <td className="px-4 py-3">{shortcut.description}</td>
                      <td className="px-4 py-3 text-[var(--text-muted)]">{shortcut.scope}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
