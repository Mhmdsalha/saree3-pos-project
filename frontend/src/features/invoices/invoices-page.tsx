import { useDeferredValue, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { printInvoice } from '@/features/cashier/print-invoice'
import { apiGet, apiRequest, resolveApiOrigin } from '@/lib/api-client'
import { getStoredSessionSnapshot, getStoredUser } from '@/lib/auth'
import { publishNotice } from '@/lib/notice-center'
import { formatMoneyWithCurrency } from '@/lib/storefront'
import { formatHebronDayLabel, formatHebronShortDateTime, hebronDateKey, hebronMonthKey } from '@/lib/time'
import type { CustomerTelegramStatus, InvoiceOut, PaginatedInvoicesResponse, User } from '@/types/api'

type InvoiceStatusFilter = 'all' | 'paid' | 'unpaid' | 'cancelled'
type PaymentMethodFilter = 'all' | 'cash' | 'card' | 'digital'

async function fetchInvoices(params: {
  page: number
  size: number
  month: string
  status: InvoiceStatusFilter
  payment: PaymentMethodFilter
  cashierId: string
  search: string
}) {
  const searchParams = new URLSearchParams({
    page: String(params.page),
    size: String(params.size),
  })
  if (params.month) searchParams.set('month', params.month)
  if (params.status !== 'all') searchParams.set('status', params.status)
  if (params.payment !== 'all') searchParams.set('payment_method', params.payment)
  if (params.cashierId) searchParams.set('cashier_id', params.cashierId)
  if (params.search.trim()) searchParams.set('search', params.search.trim())
  return apiGet<PaginatedInvoicesResponse>(`/invoices?${searchParams.toString()}`)
}

async function fetchInvoiceDetail(invoiceId: number) {
  return apiGet<InvoiceOut>(`/invoices/${invoiceId}`)
}

async function fetchCashiers() {
  return apiGet<User[]>('/users')
}

async function fetchCustomerTelegramStatus(phone: string) {
  return apiGet<CustomerTelegramStatus>(`/customers/telegram/status?phone=${encodeURIComponent(phone)}`)
}

export function InvoicesPage() {
  const session = getStoredUser()
  const isAdminView = session?.user.role !== 'cashier'
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [month, setMonth] = useState(() => hebronMonthKey())
  const [status, setStatus] = useState<InvoiceStatusFilter>('all')
  const [payment, setPayment] = useState<PaymentMethodFilter>('all')
  const [cashierId, setCashierId] = useState('')
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<number | null>(null)
  const deferredSearch = useDeferredValue(search)

  const invoicesQuery = useQuery({
    queryKey: ['invoices', page, month, status, payment, cashierId, deferredSearch],
    queryFn: () =>
      fetchInvoices({
        page,
        size: 40,
        month,
        status,
        payment,
        cashierId,
        search: deferredSearch,
      }),
  })

  const cashiersQuery = useQuery({
    queryKey: ['users', 'cashiers-filter'],
    queryFn: fetchCashiers,
    enabled: isAdminView,
  })

  const invoiceDetailQuery = useQuery({
    queryKey: ['invoice', selectedInvoiceId],
    queryFn: () => fetchInvoiceDetail(selectedInvoiceId as number),
    enabled: selectedInvoiceId !== null,
  })

  const invoicePhone = (invoiceDetailQuery.data?.customer_phone || '').trim()

  const invoiceTelegramQuery = useQuery({
    queryKey: ['invoice-telegram-status', invoicePhone],
    queryFn: () => fetchCustomerTelegramStatus(invoicePhone),
    enabled: invoicePhone.length >= 7,
    refetchInterval: (query) =>
      query.state.data?.telegram_activation_status === 'pending' ? 4_000 : false,
  })

  const markPaidMutation = useMutation({
    mutationFn: async (invoiceId: number) => {
      return apiRequest<{ ok: boolean }>(`/invoices/${invoiceId}/pay`, {
        method: 'PUT',
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      if (selectedInvoiceId !== null) {
        queryClient.invalidateQueries({ queryKey: ['invoice', selectedInvoiceId] })
      }
    },
    onError: (error: Error) => {
      publishNotice(error.message, 'error')
    },
  })

  const sendTelegramPdfMutation = useMutation({
    mutationFn: async (invoiceId: number) => {
      return apiRequest<{ ok: boolean; status: string; sent_at?: string | null }>(`/invoices/${invoiceId}/send-telegram-pdf`, {
        method: 'POST',
      })
    },
    onSuccess: () => {
      publishNotice('تم إرسال الفاتورة PDF إلى تيليجرام بنجاح.', 'success')
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      if (selectedInvoiceId !== null) {
        queryClient.invalidateQueries({ queryKey: ['invoice', selectedInvoiceId] })
      }
    },
    onError: (error: Error) => {
      publishNotice(error.message, 'error')
    },
  })

  const activateTelegramMutation = useMutation({
    mutationFn: async () => {
      const phone = (invoiceDetailQuery.data?.customer_phone || '').trim()
      if (!phone) {
        throw new Error('لا يوجد رقم هاتف لهذا العميل.')
      }
      const snapshot = getStoredSessionSnapshot()
      if (!snapshot?.sessionToken) {
        throw new Error('تعذر تحديد جلسة الكاشير الحالية لتفعيل تيليجرام.')
      }
      return apiRequest<CustomerTelegramStatus>('/customers/telegram/activation-request', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: invoiceDetailQuery.data?.customer_name?.trim() || null,
          phone_number: phone,
          session_token: snapshot.sessionToken,
        }),
      })
    },
    onSuccess: (payload) => {
      publishNotice(payload.telegram_status_label, payload.telegram_activation_status === 'activated' ? 'success' : 'info')
      queryClient.setQueryData(['invoice-telegram-status', (invoiceDetailQuery.data?.customer_phone || '').trim()], payload)
    },
    onError: (error: Error) => {
      publishNotice(error.message, 'error')
    },
  })

  const groupedInvoices = useMemo(() => {
    const map = new Map<string, InvoiceOut[]>()
    for (const invoice of invoicesQuery.data?.items ?? []) {
      const key = hebronDateKey(invoice.created_at)
      map.set(key, [...(map.get(key) ?? []), invoice])
    }
    return Array.from(map.entries())
  }, [invoicesQuery.data?.items])

  const summary = useMemo(() => {
    const items = invoicesQuery.data?.items ?? []
    return {
      invoices: invoicesQuery.data?.total ?? items.length,
      paid: items.filter((item) => item.is_paid && !item.is_cancelled).length,
      unpaid: items.filter((item) => !item.is_paid && !item.is_cancelled).length,
      cancelled: items.filter((item) => item.is_cancelled).length,
      net: items.reduce((sum, item) => sum + Number(item.net_total ?? item.final_total ?? 0), 0),
    }
  }, [invoicesQuery.data?.items, invoicesQuery.data?.total])

  const exportCsv = async () => {
    if (!isAdminView) return
    try {
      const params = new URLSearchParams()
      if (month) params.set('month', month)
      if (status !== 'all') params.set('status', status)
      if (payment !== 'all') params.set('payment_method', payment)
      if (cashierId) params.set('cashier_id', cashierId)
      const response = await fetch(`${resolveApiOrigin(true)}/invoices/export/csv?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${session?.token ?? ''}`,
        },
      })
      if (!response.ok) {
        throw new Error('تعذر تصدير ملف CSV.')
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `invoices-${month || 'all'}.csv`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      publishNotice(error instanceof Error ? error.message : 'تعذر تصدير الملف.', 'error')
    }
  }

  const printSelectedInvoice = async () => {
    if (!invoiceDetailQuery.data) return
    try {
      await printInvoice(invoiceDetailQuery.data.id, invoiceDetailQuery.data.cashier_name || session?.user.name || '—')
    } catch (error) {
      publishNotice(error instanceof Error ? error.message : 'تعذر طباعة الفاتورة.', 'error')
    }
  }

  const copyActivationLink = async () => {
    const activationUrl = invoiceTelegramQuery.data?.activation_url
    if (!activationUrl) return
    try {
      await navigator.clipboard.writeText(activationUrl)
      publishNotice('تم نسخ رابط التفعيل.', 'success')
    } catch {
      publishNotice('تعذر نسخ رابط التفعيل.', 'error')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black">الفواتير</h2>
          <p className="mt-2 text-sm text-[var(--text-muted)]">سجل الفواتير الحالي مع نفس الفلاتر والتفاصيل والترقيم، لكن بهيكل React حديث وآمن.</p>
        </div>
        <div className="flex gap-2">
          {isAdminView ? (
            <Button type="button" variant="secondary" onClick={exportCsv}>
              تصدير CSV
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setSearch('')
              setMonth(hebronMonthKey())
              setStatus('all')
              setPayment('all')
              setCashierId('')
              setPage(1)
            }}
          >
            إعادة الضبط
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(240px,1.2fr)_180px_170px_170px_minmax(180px,220px)] gap-3">
        <Input
          placeholder="ابحث برقم الفاتورة أو اسم العميل"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(1)
          }}
        />
        <Input
          type="month"
          value={month}
          onChange={(event) => {
            setMonth(event.target.value)
            setPage(1)
          }}
        />
        <select
          className="h-12 rounded-[18px] border border-[var(--line)] bg-white px-4"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as InvoiceStatusFilter)
            setPage(1)
          }}
        >
          <option value="all">كل الحالات</option>
          <option value="paid">مدفوعة</option>
          <option value="unpaid">غير مدفوعة</option>
          <option value="cancelled">ملغاة</option>
        </select>
        <select
          className="h-12 rounded-[18px] border border-[var(--line)] bg-white px-4"
          value={payment}
          onChange={(event) => {
            setPayment(event.target.value as PaymentMethodFilter)
            setPage(1)
          }}
        >
          <option value="all">كل طرق الدفع</option>
          <option value="cash">نقدي</option>
          <option value="card">بطاقة</option>
          <option value="digital">رقمي</option>
        </select>
        {isAdminView ? (
          <select
            className="h-12 rounded-[18px] border border-[var(--line)] bg-white px-4"
            value={cashierId}
            onChange={(event) => {
              setCashierId(event.target.value)
              setPage(1)
            }}
          >
            <option value="">كل الكاشيرين</option>
            {(cashiersQuery.data ?? []).map((user) => (
              <option key={user.id} value={String(user.id)}>
                {user.name}
              </option>
            ))}
          </select>
        ) : (
          <Card className="flex items-center justify-center rounded-[18px] p-3 text-sm text-[var(--text-muted)] shadow-none">فواتيري فقط</Card>
        )}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <SummaryCard title="عدد الفواتير" value={String(summary.invoices)} />
        <SummaryCard title="مدفوعة" value={String(summary.paid)} accent="green" />
        <SummaryCard title="غير مدفوعة" value={String(summary.unpaid)} accent="amber" />
        <SummaryCard title="ملغاة" value={String(summary.cancelled)} accent="red" />
        <SummaryCard title="الصافي" value={formatMoneyWithCurrency(summary.net)} accent="brand" />
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between gap-4 border-b border-[var(--line)] px-4 py-3">
          <div className="text-lg font-black">سجل الفواتير</div>
          <div className="text-xs font-bold text-[var(--text-muted)]">
            صفحة {invoicesQuery.data?.page ?? page} من {invoicesQuery.data?.pages ?? 1}
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {invoicesQuery.isLoading ? (
            <EmptyState message="جارٍ تحميل الفواتير..." />
          ) : groupedInvoices.length ? (
            groupedInvoices.map(([day, items]) => (
              <section key={day} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-base font-black">{formatHebronDayLabel(day)}</div>
                  <div className="text-xs font-bold text-[var(--text-muted)]">{items.length} فاتورة</div>
                </div>
                <div className="space-y-2">
                  {items.map((invoice) => (
                    <button
                      key={invoice.id}
                      type="button"
                      onClick={() => setSelectedInvoiceId(invoice.id)}
                      className="grid w-full grid-cols-[94px_minmax(0,1fr)_112px_102px_102px_92px] items-center gap-3 rounded-[20px] border border-[var(--line)] bg-[var(--muted)] px-3 py-3 text-right transition-colors hover:border-[var(--brand-soft)] hover:bg-white"
                    >
                      <div>
                        <div className="text-sm text-[var(--text-muted)]">الفاتورة</div>
                        <div className="mt-1 text-lg font-black">#{invoice.id}</div>
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-black">{invoice.customer_name || 'بدون اسم عميل'}</div>
                        <div className="mt-1 text-xs text-[var(--text-muted)]">
                          {invoice.cashier_name || '—'} • {formatHebronShortDateTime(invoice.created_at)}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          <StatusBadge type={invoice.is_cancelled ? 'cancelled' : invoice.is_paid ? 'paid' : 'unpaid'} />
                          <BadgePill>{paymentMethodLabel(invoice.payment_method)}</BadgePill>
                          {invoice.is_returned ? <BadgePill tone="orange">بها مرتجع</BadgePill> : null}
                        </div>
                      </div>
                      <AmountBlock label="الإجمالي" value={invoice.final_total} />
                      <AmountBlock label="المرتجع" value={invoice.returned_amount ?? 0} />
                      <AmountBlock label="الصافي" value={invoice.net_total ?? invoice.final_total} strong />
                      <div className="text-xs font-bold text-[var(--brand)]">فتح التفاصيل</div>
                    </button>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <EmptyState message="لا توجد فواتير مطابقة لهذه الفلاتر." />
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-4">
          <Button type="button" variant="secondary" disabled={!invoicesQuery.data?.has_prev} onClick={() => setPage((current) => Math.max(1, current - 1))}>
            الصفحة السابقة
          </Button>
          <div className="text-sm text-[var(--text-muted)]">
            إجمالي النتائج: <strong>{invoicesQuery.data?.total ?? 0}</strong>
          </div>
          <Button type="button" variant="secondary" disabled={!invoicesQuery.data?.has_next} onClick={() => setPage((current) => current + 1)}>
            الصفحة التالية
          </Button>
        </div>
      </Card>

      <Dialog open={selectedInvoiceId !== null} onClose={() => setSelectedInvoiceId(null)} className="max-w-5xl">
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-2xl font-black">تفاصيل الفاتورة {selectedInvoiceId ? `#${selectedInvoiceId}` : ''}</h3>
              <div className="mt-2 text-sm text-[var(--text-muted)]">
                {invoiceDetailQuery.data ? `${invoiceDetailQuery.data.customer_name || 'بدون اسم'} • ${formatHebronShortDateTime(invoiceDetailQuery.data.created_at)}` : 'جارٍ التحميل...'}
              </div>
            </div>
            <div className="flex gap-2">
              {invoiceDetailQuery.data ? (
                <Button type="button" variant="secondary" onClick={() => void printSelectedInvoice()}>
                  طباعة الفاتورة
                </Button>
              ) : null}
              {invoiceDetailQuery.data && !invoiceDetailQuery.data.is_cancelled ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => sendTelegramPdfMutation.mutate(invoiceDetailQuery.data!.id)}
                  disabled={sendTelegramPdfMutation.isPending}
                >
                  {sendTelegramPdfMutation.isPending
                    ? 'جارٍ الإرسال...'
                    : invoiceDetailQuery.data.invoice_sent_to_telegram
                      ? 'إعادة الإرسال لتيليجرام'
                      : 'إرسال PDF لتيليجرام'}
                </Button>
              ) : null}
              {invoiceDetailQuery.data && invoicePhone ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => activateTelegramMutation.mutate()}
                  disabled={activateTelegramMutation.isPending || invoiceTelegramQuery.data?.telegram_activation_status === 'activated'}
                >
                  {activateTelegramMutation.isPending
                    ? 'جارٍ تجهيز التفعيل...'
                    : invoiceTelegramQuery.data?.telegram_activation_status === 'activated'
                      ? 'تيليجرام مفعل'
                      : invoiceTelegramQuery.data?.telegram_activation_status === 'pending'
                        ? 'إعادة إرسال التفعيل'
                        : 'تفعيل تيليجرام'}
                </Button>
              ) : null}
              {invoiceDetailQuery.data && !invoiceDetailQuery.data.is_cancelled && !invoiceDetailQuery.data.is_paid ? (
                <Button type="button" onClick={() => markPaidMutation.mutate(invoiceDetailQuery.data!.id)} disabled={markPaidMutation.isPending}>
                  {markPaidMutation.isPending ? 'جارٍ التحديث...' : 'تعليم كمدفوعة'}
                </Button>
              ) : null}
              <Button type="button" variant="secondary" onClick={() => setSelectedInvoiceId(null)}>
                إغلاق
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <SummaryCard title="طريقة الدفع" value={paymentMethodLabel(invoiceDetailQuery.data?.payment_method)} compact />
            <SummaryCard title="الإجمالي" value={formatMoneyWithCurrency(invoiceDetailQuery.data?.final_total ?? 0)} compact />
            <SummaryCard title="الحالة" value={invoiceStatusLabel(invoiceDetailQuery.data)} compact />
            <SummaryCard title="عدد البنود" value={String(invoiceDetailQuery.data?.items.length ?? 0)} compact />
          </div>

          {invoiceDetailQuery.data ? (
            <Card className="rounded-[20px] p-4 shadow-none">
              <div className="flex flex-col gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-bold text-[var(--text-muted)]">حالة إرسال الفاتورة:</span>
                  <span className={invoiceDetailQuery.data.invoice_sent_to_telegram ? 'font-black text-emerald-700' : 'font-black text-amber-700'}>
                    {invoiceDetailQuery.data.invoice_sent_to_telegram ? 'تم إرسال PDF' : 'لم تُرسل بعد'}
                  </span>
                  {invoiceDetailQuery.data.invoice_telegram_sent_at ? (
                    <span className="text-[var(--text-muted)]">
                      آخر إرسال: {formatHebronShortDateTime(invoiceDetailQuery.data.invoice_telegram_sent_at)}
                    </span>
                  ) : null}
                </div>
                {invoicePhone ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-bold text-[var(--text-muted)]">تيليجرام العميل:</span>
                    <span
                      className={
                        invoiceTelegramQuery.data?.telegram_activation_status === 'activated'
                          ? 'font-black text-emerald-700'
                          : invoiceTelegramQuery.data?.telegram_activation_status === 'pending'
                            ? 'font-black text-amber-700'
                            : 'font-black text-slate-700'
                      }
                    >
                      {invoiceTelegramQuery.data?.telegram_status_label || 'غير مفعل'}
                    </span>
                    {invoiceTelegramQuery.data?.activation_url ? (
                      <Button type="button" variant="secondary" onClick={() => void copyActivationLink()}>
                        نسخ رابط التفعيل
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-[var(--text-muted)]">لا يوجد رقم هاتف مرتبط بهذه الفاتورة لتفعيل تيليجرام.</div>
                )}
              </div>
            </Card>
          ) : null}

          <Card className="overflow-hidden p-0 shadow-none">
            <div className="border-b border-[var(--line)] px-4 py-4 text-lg font-black">بنود الفاتورة</div>
            <div className="max-h-[360px] overflow-auto">
              <table className="w-full text-right text-sm">
                <thead className="sticky top-0 bg-[var(--muted)]">
                  <tr className="border-b border-[var(--line)]">
                    <th className="px-4 py-3">الصنف</th>
                    <th className="px-4 py-3">الكمية</th>
                    <th className="px-4 py-3">سعر الوحدة</th>
                    <th className="px-4 py-3">الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  {invoiceDetailQuery.isLoading ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-[var(--text-muted)]">
                        جارٍ تحميل البنود...
                      </td>
                    </tr>
                  ) : (
                    (invoiceDetailQuery.data?.items ?? []).map((item) => (
                      <tr key={item.id} className="border-b border-[var(--line)]">
                        <td className="px-4 py-3 font-bold">{item.product_name || `#${item.product_id}`}</td>
                        <td className="px-4 py-3">{formatQty(item.quantity)}</td>
                        <td className="px-4 py-3">{formatMoney(item.price)}</td>
                        <td className="px-4 py-3 font-bold text-[var(--brand)]">{formatMoney(item.subtotal)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </Dialog>
    </div>
  )
}

function SummaryCard({
  title,
  value,
  accent,
  compact,
}: {
  title: string
  value: string
  accent?: 'brand' | 'green' | 'amber' | 'red'
  compact?: boolean
}) {
  const color =
    accent === 'green'
      ? 'text-emerald-700'
      : accent === 'amber'
        ? 'text-amber-700'
        : accent === 'red'
          ? 'text-red-700'
          : accent === 'brand'
            ? 'text-[var(--brand)]'
            : 'text-[var(--text-strong)]'

  return (
    <Card className={`rounded-[24px] ${compact ? 'p-4' : 'p-5'} shadow-none`}>
      <div className="text-sm text-[var(--text-muted)]">{title}</div>
      <div className={`mt-3 ${compact ? 'text-xl' : 'text-2xl'} font-black ${color}`}>{value}</div>
    </Card>
  )
}

function AmountBlock({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div>
      <div className="text-xs text-[var(--text-muted)]">{label}</div>
      <div className={`mt-2 ${strong ? 'text-xl' : 'text-lg'} font-black ${strong ? 'text-[var(--brand)]' : ''}`}>{formatMoneyWithCurrency(value)}</div>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return <div className="rounded-[24px] border border-dashed border-[var(--line)] px-5 py-12 text-center text-sm text-[var(--text-muted)]">{message}</div>
}

function BadgePill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'orange' }) {
  return (
    <span
      className={
        tone === 'orange'
          ? 'rounded-full bg-orange-100 px-3 py-1 font-bold text-orange-700'
          : 'rounded-full bg-white px-3 py-1 font-bold text-[var(--text-muted)]'
      }
    >
      {children}
    </span>
  )
}

function StatusBadge({ type }: { type: 'paid' | 'unpaid' | 'cancelled' }) {
  const className =
    type === 'paid'
      ? 'bg-emerald-100 text-emerald-700'
      : type === 'unpaid'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-red-100 text-red-700'
  const label = type === 'paid' ? 'مدفوعة' : type === 'unpaid' ? 'غير مدفوعة' : 'ملغاة'
  return <span className={`rounded-full px-3 py-1 text-xs font-black ${className}`}>{label}</span>
}

function invoiceStatusLabel(invoice?: InvoiceOut) {
  if (!invoice) return '—'
  if (invoice.is_cancelled) return 'ملغاة'
  return invoice.is_paid ? 'مدفوعة' : 'غير مدفوعة'
}

function paymentMethodLabel(value?: string | null) {
  return value === 'cash' ? 'نقدي' : value === 'card' ? 'بطاقة' : value === 'digital' ? 'رقمي' : '—'
}

function formatMoney(value: number) {
  return Number(value || 0).toFixed(2)
}

function formatQty(value: number) {
  return Number(value || 0) % 1 === 0 ? String(Number(value || 0)) : Number(value || 0).toFixed(3)
}
