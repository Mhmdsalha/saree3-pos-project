import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiGet } from '@/lib/api-client'
import type { CustomerRecord } from '@/types/api'

type CustomerStatusFilter = 'all' | 'activated' | 'pending' | 'inactive'

async function fetchCustomers() {
  return apiGet<CustomerRecord[]>('/customers')
}

function formatDateTime(value?: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ar-PS', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Hebron',
  }).format(new Date(value))
}

function statusTone(status: string) {
  if (status === 'activated') return 'bg-emerald-50 text-emerald-700'
  if (status === 'pending') return 'bg-amber-50 text-amber-700'
  return 'bg-slate-100 text-slate-700'
}

export function CustomersPage() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<CustomerStatusFilter>('all')

  const customersQuery = useQuery({
    queryKey: ['customers'],
    queryFn: fetchCustomers,
  })

  const stats = useMemo(() => {
    const all = customersQuery.data ?? []
    return {
      total: all.length,
      activated: all.filter((customer) => customer.telegram_activation_status === 'activated').length,
      pending: all.filter((customer) => customer.telegram_activation_status === 'pending').length,
      inactive: all.filter((customer) => customer.telegram_activation_status !== 'activated' && customer.telegram_activation_status !== 'pending').length,
    }
  }, [customersQuery.data])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (customersQuery.data ?? []).filter((customer) => {
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'inactive'
            ? customer.telegram_activation_status !== 'activated' && customer.telegram_activation_status !== 'pending'
            : customer.telegram_activation_status === statusFilter

      if (!matchesStatus) return false
      if (!q) return true

      return [customer.customer_name, customer.phone_number, customer.telegram_username]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    })
  }, [customersQuery.data, search, statusFilter])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black">العملاء</h2>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            قائمة العملاء المسجلين داخل النظام مع أرقامهم وحالة تفعيل تيليجرام.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,260px)_repeat(4,minmax(0,1fr))] gap-3">
        <Input placeholder="بحث بالاسم أو الرقم أو يوزر تيليجرام..." value={search} onChange={(event) => setSearch(event.target.value)} />
        <StatCard title="إجمالي العملاء" value={String(stats.total)} />
        <StatCard title="مفعّلون" value={String(stats.activated)} />
        <StatCard title="بانتظار التفعيل" value={String(stats.pending)} />
        <StatCard title="غير مفعّلين" value={String(stats.inactive)} />
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" variant={statusFilter === 'all' ? 'default' : 'secondary'} className="rounded-2xl" onClick={() => setStatusFilter('all')}>
          الكل
        </Button>
        <Button type="button" variant={statusFilter === 'activated' ? 'default' : 'secondary'} className="rounded-2xl" onClick={() => setStatusFilter('activated')}>
          المفعّلون
        </Button>
        <Button type="button" variant={statusFilter === 'pending' ? 'default' : 'secondary'} className="rounded-2xl" onClick={() => setStatusFilter('pending')}>
          بانتظار التفعيل
        </Button>
        <Button type="button" variant={statusFilter === 'inactive' ? 'default' : 'secondary'} className="rounded-2xl" onClick={() => setStatusFilter('inactive')}>
          غير مفعّلين
        </Button>
      </div>

      <Card className="min-h-0 flex-1 overflow-hidden p-0">
        <div className="h-full overflow-auto">
          <table className="w-full text-right">
            <thead className="sticky top-0 bg-[var(--muted)] text-sm">
              <tr className="border-b border-[var(--line)]">
                <th className="px-4 py-3">الاسم</th>
                <th className="px-4 py-3">رقم الهاتف</th>
                <th className="px-4 py-3">حالة تيليجرام</th>
                <th className="px-4 py-3">يوزر تيليجرام</th>
                <th className="px-4 py-3">تاريخ التفعيل</th>
                <th className="px-4 py-3">آخر تحديث</th>
              </tr>
            </thead>
            <tbody>
              {customersQuery.isLoading ? (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={6}>
                    جارٍ تحميل العملاء...
                  </td>
                </tr>
              ) : rows.length ? (
                rows.map((customer) => (
                  <tr key={customer.id} className="border-b border-[var(--line)] text-sm">
                    <td className="px-4 py-3 font-bold">{customer.customer_name || 'بدون اسم'}</td>
                    <td className="px-4 py-3">{customer.phone_number}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-bold ${statusTone(customer.telegram_activation_status)}`}>
                        {customer.telegram_status_label}
                      </span>
                    </td>
                    <td className="px-4 py-3">{customer.telegram_username ? `@${customer.telegram_username}` : '—'}</td>
                    <td className="px-4 py-3">{formatDateTime(customer.telegram_activated_at)}</td>
                    <td className="px-4 py-3">{formatDateTime(customer.updated_at)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={6}>
                    لا توجد نتائج مطابقة.
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

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card className="rounded-[24px] p-4 shadow-none">
      <div className="text-sm text-[var(--text-muted)]">{title}</div>
      <div className="mt-3 text-2xl font-black">{value}</div>
    </Card>
  )
}
