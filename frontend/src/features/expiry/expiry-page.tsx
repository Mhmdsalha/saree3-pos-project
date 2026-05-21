import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { apiGet } from '@/lib/api-client'
import type { ExpiryReport } from '@/types/api'

type ExpiryFilter = 'all' | 'expired' | 'critical' | 'warning'

async function fetchExpiry(days: number) {
  return apiGet<ExpiryReport>(`/reports/expiry?days=${days}`)
}

export function ExpiryPage() {
  const [days, setDays] = useState('7')
  const [filter, setFilter] = useState<ExpiryFilter>('all')

  const daysValue = Number(days || 7)
  const expiryQuery = useQuery({
    queryKey: ['reports', 'expiry', daysValue],
    queryFn: () => fetchExpiry(daysValue),
  })

  const rows = useMemo(() => {
    const items = expiryQuery.data?.items ?? []
    if (filter === 'all') return items
    if (filter === 'expired') return items.filter((item) => item.status === 'expired')
    if (filter === 'critical') return items.filter((item) => item.status === 'critical')
    return items.filter((item) => item.status === 'warning' || item.status === 'expires_today')
  }, [expiryQuery.data, filter])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pb-4 pr-1">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black">الصلاحية</h2>
          <p className="mt-2 text-sm text-[var(--text-muted)]">متابعة الأصناف القريبة من الانتهاء بنفس endpoint الحالي مع نفس منطق الحالات والتنبيه.</p>
        </div>
        <Button type="button" variant="secondary" onClick={() => expiryQuery.refetch()}>
          تحديث
        </Button>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-bold text-[var(--text-muted)]">إنذار قبل</span>
          <input
            type="number"
            min="1"
            max="90"
            className="h-11 w-[90px] rounded-2xl border border-[var(--line)] bg-white px-3 text-center font-bold outline-none"
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
          <span className="text-sm font-bold text-[var(--text-muted)]">يوم</span>
          <span className="mr-auto text-xs text-[var(--text-muted)]">يمكنك تغيير عدد الأيام وسيتم تحديث القائمة تلقائيًا.</span>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <FilterChip label="الكل" count={expiryQuery.data?.total ?? 0} active={filter === 'all'} onClick={() => setFilter('all')} />
        <FilterChip label="منتهية" count={expiryQuery.data?.expired ?? 0} active={filter === 'expired'} onClick={() => setFilter('expired')} tone="red" />
        <FilterChip label="حرجة" count={expiryQuery.data?.critical ?? 0} active={filter === 'critical'} onClick={() => setFilter('critical')} tone="amber" />
        <FilterChip label="قريبة" count={expiryQuery.data?.warning ?? 0} active={filter === 'warning'} onClick={() => setFilter('warning')} tone="brand" />
      </div>

      <Card className="min-h-0 flex-1 overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-right">
            <thead className="sticky top-0 bg-[var(--muted)] text-sm">
              <tr className="border-b border-[var(--line)]">
                <th className="px-4 py-3">المنتج</th>
                <th className="px-4 py-3">الباركود</th>
                <th className="px-4 py-3">المخزون</th>
                <th className="px-4 py-3">تاريخ الصلاحية</th>
                <th className="px-4 py-3">الأيام المتبقية</th>
                <th className="px-4 py-3">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {expiryQuery.isLoading ? (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={6}>
                    جارٍ تحميل البيانات...
                  </td>
                </tr>
              ) : rows.length ? (
                rows.map((item) => (
                  <tr key={item.id} className={item.status === 'expired' ? 'bg-red-50/50' : item.status === 'critical' ? 'bg-amber-50/50' : ''}>
                    <td className="px-4 py-3 font-bold">{item.name}</td>
                    <td className="px-4 py-3 font-mono text-xs">{item.barcode}</td>
                    <td className="px-4 py-3">{item.stock}</td>
                    <td className="px-4 py-3">{formatDate(item.expiry_date)}</td>
                    <td className="px-4 py-3">{daysLabel(item.days_left)}</td>
                    <td className="px-4 py-3">
                      <span className={statusBadge(item.status).className}>{statusBadge(item.status).text}</span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={6}>
                    لا توجد منتجات في هذه الفئة.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

function FilterChip({
  label,
  count,
  active,
  onClick,
  tone = 'neutral',
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  tone?: 'neutral' | 'red' | 'amber' | 'brand'
}) {
  const toneClass =
    tone === 'red'
      ? 'bg-red-50 text-red-700 border-red-200'
      : tone === 'amber'
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : tone === 'brand'
          ? 'bg-orange-50 text-orange-700 border-orange-200'
          : 'bg-slate-100 text-slate-700 border-slate-200'

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-black ${toneClass} ${active ? 'ring-2 ring-current/30' : ''}`}
    >
      {label}
      <span>{count}</span>
    </button>
  )
}

function formatDate(value?: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('ar-PS', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Hebron' })
}

function daysLabel(daysLeft: number) {
  if (daysLeft < 0) return `منذ ${Math.abs(daysLeft)} يوم`
  return `${daysLeft} يوم`
}

function statusBadge(status: string) {
  if (status === 'expired') {
    return { text: 'منتهية', className: 'rounded-full bg-red-50 px-3 py-1 text-xs font-black text-red-700' }
  }
  if (status === 'expires_today') {
    return { text: 'اليوم', className: 'rounded-full bg-red-100 px-3 py-1 text-xs font-black text-red-700' }
  }
  if (status === 'critical') {
    return { text: 'حرجة', className: 'rounded-full bg-amber-50 px-3 py-1 text-xs font-black text-amber-700' }
  }
  return { text: 'قريبة', className: 'rounded-full bg-orange-50 px-3 py-1 text-xs font-black text-orange-700' }
}
