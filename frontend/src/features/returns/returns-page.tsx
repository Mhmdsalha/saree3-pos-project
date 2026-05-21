import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiGet, apiRequest } from '@/lib/api-client'
import { publishNotice } from '@/lib/notice-center'
import { formatMoneyWithCurrency } from '@/lib/storefront'
import type { InvoiceOut, ReturnCreatePayload, ReturnHistory } from '@/types/api'

async function fetchReturnsInvoice(invoiceId: number) {
  return apiGet<InvoiceOut>(`/invoices/${invoiceId}`)
}

async function fetchReturnsHistory(invoiceId: number) {
  return apiGet<ReturnHistory[]>(`/returns/invoice/${invoiceId}`)
}

export function ReturnsPage() {
  const queryClient = useQueryClient()
  const [invoiceIdInput, setInvoiceIdInput] = useState('')
  const [invoiceId, setInvoiceId] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [refundMethod, setRefundMethod] = useState<'cash' | 'card' | 'digital'>('cash')
  const [quantities, setQuantities] = useState<Record<number, string>>({})

  const invoiceQuery = useQuery({
    queryKey: ['returns', 'invoice', invoiceId],
    queryFn: () => fetchReturnsInvoice(invoiceId as number),
    enabled: invoiceId !== null,
  })

  const historyQuery = useQuery({
    queryKey: ['returns', 'history', invoiceId],
    queryFn: () => fetchReturnsHistory(invoiceId as number),
    enabled: invoiceId !== null,
  })

  const returnMutation = useMutation({
    mutationFn: async (payload: ReturnCreatePayload) => {
      return apiRequest('/returns', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      setQuantities({})
      setReason('')
      publishNotice('تم تنفيذ الإرجاع بنجاح.', 'success')
      if (invoiceId !== null) {
        queryClient.invalidateQueries({ queryKey: ['returns', 'invoice', invoiceId] })
        queryClient.invalidateQueries({ queryKey: ['returns', 'history', invoiceId] })
      }
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
    },
    onError: (mutationError: Error) => {
      publishNotice(mutationError.message, 'error')
    },
  })

  const returnedMap = useMemo(() => {
    const map = new Map<number, number>()
    for (const entry of historyQuery.data ?? []) {
      for (const item of entry.items ?? []) {
        map.set(item.invoice_item_id, (map.get(item.invoice_item_id) ?? 0) + Number(item.quantity || 0))
      }
    }
    return map
  }, [historyQuery.data])

  const rows = useMemo(() => {
    return (invoiceQuery.data?.items ?? []).map((item) => {
      const sold = Number(item.quantity || 0)
      const returned = returnedMap.get(item.id) ?? 0
      const remaining = Math.max(0, sold - returned)
      return {
        ...item,
        sold,
        returned,
        remaining,
      }
    })
  }, [invoiceQuery.data, returnedMap])

  const preview = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        const qty = Number(quantities[row.id] || 0)
        if (qty > 0) {
          acc.items.push({
            invoice_item_id: row.id,
            quantity: qty,
          })
          acc.total += qty * Number(row.price || 0)
        }
        return acc
      },
      { total: 0, items: [] as Array<{ invoice_item_id: number; quantity: number }> },
    )
  }, [rows, quantities])

  const loadInvoice = () => {
    const nextId = Number(invoiceIdInput || 0)
    if (!nextId) {
      publishNotice('أدخل رقم الفاتورة أولًا.', 'error')
      return
    }
    setQuantities({})
    setInvoiceId(nextId)
  }

  const submitReturn = async () => {
    if (!invoiceQuery.data) {
      publishNotice('حمّل الفاتورة أولًا.', 'error')
      return
    }
    if (!preview.items.length) {
      publishNotice('أدخل بندًا واحدًا على الأقل للإرجاع.', 'error')
      return
    }

    await returnMutation.mutateAsync({
      invoice_id: invoiceQuery.data.id,
      items: preview.items,
      reason: reason.trim() || null,
      refund_method: refundMethod,
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black">المرتجعات</h2>
          <p className="mt-2 text-sm text-[var(--text-muted)]">بحث برقم الفاتورة، تحميل البنود، إرجاع كامل أو جزئي، ثم تحديث الرصيد والتاريخ من نفس الـ API الحالي.</p>
        </div>
      </div>

      <div className="grid grid-cols-[340px_minmax(0,1fr)] gap-4">
        <Card className="p-4">
          <div className="space-y-4">
            <div className="text-lg font-black">بحث الفاتورة</div>
            <div className="flex gap-2">
              <Input placeholder="رقم الفاتورة" value={invoiceIdInput} onChange={(event) => setInvoiceIdInput(event.target.value)} />
              <Button type="button" onClick={loadInvoice}>
                تحميل
              </Button>
            </div>

            <select className="h-12 w-full rounded-2xl border border-[var(--line)] bg-white px-4" value={refundMethod} onChange={(event) => setRefundMethod(event.target.value as 'cash' | 'card' | 'digital')}>
              <option value="cash">استرجاع نقدي</option>
              <option value="card">استرجاع بطاقة</option>
              <option value="digital">استرجاع رقمي</option>
            </select>

            <textarea
              className="min-h-28 w-full rounded-[24px] border border-[var(--line)] bg-white px-4 py-3 outline-none"
              placeholder="سبب الإرجاع"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />

            <div className="grid grid-cols-2 gap-3">
              <StatCard title="إجمالي الإرجاع" value={formatMoneyWithCurrency(preview.total)} />
              <StatCard title="عدد البنود" value={String(preview.items.length)} />
            </div>

            <Button type="button" className="w-full" onClick={submitReturn} disabled={returnMutation.isPending}>
              {returnMutation.isPending ? 'جارٍ تنفيذ الإرجاع...' : 'تأكيد الإرجاع'}
            </Button>
          </div>
        </Card>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4">
          <Card className="p-4">
            <div className="grid grid-cols-[repeat(4,minmax(0,1fr))] gap-3">
              <StatCard title="رقم الفاتورة" value={invoiceQuery.data ? `#${invoiceQuery.data.id}` : '—'} />
              <StatCard title="الإجمالي النهائي" value={invoiceQuery.data ? formatMoneyWithCurrency(Number(invoiceQuery.data.final_total || 0)) : '—'} />
              <StatCard title="طريقة الدفع" value={invoiceQuery.data ? paymentMethodLabel(invoiceQuery.data.payment_method) : '—'} />
              <StatCard title="العميل" value={invoiceQuery.data?.customer_name || 'بدون اسم'} />
            </div>
          </Card>

          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_340px] gap-4">
            <Card className="min-h-0 overflow-hidden p-0">
              <TableHeader title="بنود الفاتورة القابلة للإرجاع" />
              <div className="max-h-[520px] overflow-auto">
                <table className="w-full text-right text-sm">
                  <thead className="sticky top-0 bg-[var(--muted)]">
                    <tr className="border-b border-[var(--line)]">
                      <th className="px-4 py-3">الصنف</th>
                      <th className="px-4 py-3">المباع</th>
                      <th className="px-4 py-3">مُرجع سابقًا</th>
                      <th className="px-4 py-3">المتبقي</th>
                      <th className="px-4 py-3">سعر الوحدة</th>
                      <th className="px-4 py-3">إرجاع الآن</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoiceQuery.isLoading ? (
                      <tr>
                        <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={6}>
                          جارٍ تحميل الفاتورة...
                        </td>
                      </tr>
                    ) : rows.length ? (
                      rows.map((item) => (
                        <tr key={item.id} className="border-b border-[var(--line)]">
                          <td className="px-4 py-3 font-bold">{item.product_name || `#${item.product_id}`}</td>
                          <td className="px-4 py-3">{item.sold}</td>
                          <td className="px-4 py-3">{item.returned}</td>
                          <td className="px-4 py-3">{item.remaining}</td>
                          <td className="px-4 py-3">{Number(item.price || 0).toFixed(2)}</td>
                          <td className="px-4 py-3">
                            <Input
                              type="number"
                              min="0"
                              max={item.remaining}
                              step="0.001"
                              className="h-10 rounded-xl"
                              value={quantities[item.id] ?? '0'}
                              onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: event.target.value }))}
                            />
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={6}>
                          ابحث برقم الفاتورة لبدء عملية الإرجاع.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="min-h-0 overflow-hidden p-0">
              <TableHeader title="سجل الإرجاع السابق" />
              <div className="max-h-[520px] space-y-3 overflow-auto p-4">
                {(historyQuery.data ?? []).length ? (
                  historyQuery.data!.map((entry) => (
                    <div key={entry.id} className="rounded-[22px] border border-[var(--line)] bg-[var(--muted)] p-4">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <strong>#{entry.id}</strong>
                        <span>{formatDateTime(entry.created_at)}</span>
                        <span className="font-bold text-red-600">{formatMoneyWithCurrency(Number(entry.total_refunded || 0))}</span>
                      </div>
                      <div className="mt-2 text-xs text-[var(--text-muted)]">
                        {entry.reason || 'بدون سبب'} • {paymentMethodLabel(entry.refund_method)}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-[22px] border border-dashed border-[var(--line)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                    لا يوجد سجل إرجاع سابق لهذه الفاتورة.
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

function TableHeader({ title }: { title: string }) {
  return <div className="border-b border-[var(--line)] px-4 py-4 text-lg font-black">{title}</div>
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card className="rounded-[24px] p-4 shadow-none">
      <div className="text-sm text-[var(--text-muted)]">{title}</div>
      <div className="mt-3 text-xl font-black">{value}</div>
    </Card>
  )
}

function formatDateTime(value?: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hebron' }).format(new Date(value))
}

function paymentMethodLabel(value?: string | null) {
  return value === 'cash' ? 'نقدي' : value === 'card' ? 'بطاقة' : value === 'digital' ? 'رقمي' : '—'
}
