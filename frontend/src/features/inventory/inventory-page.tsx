import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiGet, apiRequest } from '@/lib/api-client'
import { formatMoneyWithCurrency } from '@/lib/storefront'
import type { InventoryBatch, InventoryOverview, Product, ProductAlertsReport, StockCountCreatePayload, StockCountSummary, StockMovement } from '@/types/api'

async function fetchInventoryOverview() {
  return apiGet<InventoryOverview>('/inventory/overview')
}

async function fetchInventoryBatches() {
  return apiGet<InventoryBatch[]>('/inventory/batches?limit=500')
}

async function fetchInventoryMovements() {
  return apiGet<StockMovement[]>('/inventory/movements?limit=300')
}

async function fetchInventoryCounts() {
  return apiGet<StockCountSummary[]>('/inventory/counts')
}

async function fetchProducts() {
  return apiGet<Product[]>('/products')
}

async function fetchManagerAlerts() {
  return apiGet<ProductAlertsReport>('/products/alerts')
}

type InventoryTab = 'overview' | 'movements' | 'stocktaking'

export function InventoryPage({ onOpenExpiry }: { onOpenExpiry?: () => void }) {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<InventoryTab>('overview')
  const [countType, setCountType] = useState<'daily' | 'monthly'>('daily')
  const [countDate, setCountDate] = useState(() => new Date().toISOString().slice(0, 16))
  const [countProductId, setCountProductId] = useState('')
  const [countQuantity, setCountQuantity] = useState('')
  const [countReason, setCountReason] = useState('')

  const overviewQuery = useQuery({
    queryKey: ['inventory', 'overview'],
    queryFn: fetchInventoryOverview,
    enabled: activeTab === 'overview',
    staleTime: 60_000,
  })
  const batchesQuery = useQuery({
    queryKey: ['inventory', 'batches', 'latest'],
    queryFn: fetchInventoryBatches,
    enabled: activeTab === 'overview',
    staleTime: 60_000,
  })
  const movementsQuery = useQuery({
    queryKey: ['inventory', 'movements', 'latest'],
    queryFn: fetchInventoryMovements,
    enabled: activeTab === 'movements',
    staleTime: 30_000,
  })
  const countsQuery = useQuery({
    queryKey: ['inventory', 'counts'],
    queryFn: fetchInventoryCounts,
    enabled: activeTab === 'stocktaking',
    staleTime: 30_000,
  })
  const productsQuery = useQuery({
    queryKey: ['products'],
    queryFn: fetchProducts,
    enabled: activeTab === 'stocktaking',
    staleTime: 60_000,
  })
  const alertsQuery = useQuery({
    queryKey: ['products', 'alerts'],
    queryFn: fetchManagerAlerts,
    staleTime: 60_000,
  })

  const createCountMutation = useMutation({
    mutationFn: async (payload: StockCountCreatePayload) => {
      return apiRequest('/inventory/counts', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      setCountQuantity('')
      setCountReason('')
      queryClient.invalidateQueries({ queryKey: ['inventory', 'counts'] })
      queryClient.invalidateQueries({ queryKey: ['inventory', 'overview'] })
    },
  })

  const actionMutation = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: 'submit' | 'approve' }) => {
      return apiRequest(`/inventory/counts/${id}/${action}`, {
        method: 'POST',
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory', 'counts'] })
      queryClient.invalidateQueries({ queryKey: ['inventory', 'overview'] })
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })

  const summary = overviewQuery.data?.summary
  const expiryAlertCount = (alertsQuery.data?.counts.expired ?? 0) + (alertsQuery.data?.counts.near_expiry ?? 0)

  const countsRows = useMemo(() => countsQuery.data ?? [], [countsQuery.data])
  const movementRows = useMemo(() => movementsQuery.data ?? [], [movementsQuery.data])
  const stockRows = useMemo(() => overviewQuery.data?.items ?? [], [overviewQuery.data])
  const batchRows = useMemo(() => batchesQuery.data ?? [], [batchesQuery.data])

  const createCount = async () => {
    if (!countProductId || !countQuantity) return
    await createCountMutation.mutateAsync({
      count_type: countType,
      count_date: new Date(countDate).toISOString(),
      notes: countReason || null,
      items: [
        {
          product_id: Number(countProductId),
          batch_id: null,
          counted_quantity: Number(countQuantity),
          adjustment_reason: countReason || null,
          notes: null,
        },
      ],
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black">المخزون</h2>
          <p className="mt-2 text-sm text-[var(--text-muted)]">نظرة شاملة على الرصيد والحركات والجرد داخل صفحة واحدة.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenExpiry?.()}>
            تاريخ الصلاحية
            {expiryAlertCount > 0 ? (
              <span className="mr-2 inline-flex min-w-6 items-center justify-center rounded-full bg-red-600 px-2 py-0.5 text-xs font-black text-white">
                {expiryAlertCount}
              </span>
            ) : null}
          </Button>
          <Button type="button" variant={activeTab === 'overview' ? 'default' : 'secondary'} onClick={() => setActiveTab('overview')}>
            النظرة العامة
          </Button>
          <Button type="button" variant={activeTab === 'movements' ? 'default' : 'secondary'} onClick={() => setActiveTab('movements')}>
            الحركات
          </Button>
          <Button type="button" variant={activeTab === 'stocktaking' ? 'default' : 'secondary'} onClick={() => setActiveTab('stocktaking')}>
            الجرد
          </Button>
        </div>
      </div>

      {activeTab === 'overview' ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
            <StatCard title="إجمالي المنتجات" value={String(summary?.total_products ?? 0)} />
            <StatCard title="منخفضة" value={String(summary?.low_stock_count ?? 0)} />
            <StatCard title="نافدة" value={String(summary?.out_of_stock ?? 0)} />
            <StatCard title="قيمة البيع" value={formatMoneyWithCurrency(Number(summary?.total_sell_value ?? 0))} />
            <StatCard title="الهامش" value={formatMoneyWithCurrency(Number(summary?.potential_profit ?? 0))} />
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
            <Card className="flex min-h-0 flex-col overflow-hidden p-0">
              <TableHeader title="الرصيد الحالي" />
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-right text-sm">
                  <thead className="sticky top-0 bg-[var(--muted)]">
                    <tr className="border-b border-[var(--line)]">
                      <th className="px-4 py-3">الصنف</th>
                      <th className="px-4 py-3">الرصيد</th>
                      <th className="px-4 py-3">الحد الأدنى</th>
                      <th className="px-4 py-3">الحالة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockRows.map((item) => (
                      <tr key={item.id} className="border-b border-[var(--line)]">
                        <td className="px-4 py-3 font-bold">{item.name}</td>
                        <td className="px-4 py-3">{item.stock}</td>
                        <td className="px-4 py-3">{item.min_stock}</td>
                        <td className="px-4 py-3">
                          <Badge className={item.status === 'out' ? 'bg-red-50 text-red-700' : item.status === 'low' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}>
                            {item.status === 'out' ? 'نافد' : item.status === 'low' ? 'منخفض' : 'جيد'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="flex min-h-0 flex-col overflow-hidden p-0">
              <TableHeader title="الدفعات والانتهاء" />
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-right text-sm">
                  <thead className="sticky top-0 bg-[var(--muted)]">
                    <tr className="border-b border-[var(--line)]">
                      <th className="px-4 py-3">الصنف</th>
                      <th className="px-4 py-3">الدفعة</th>
                      <th className="px-4 py-3">المتاح</th>
                      <th className="px-4 py-3">الانتهاء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchRows.map((item) => (
                      <tr key={item.id} className="border-b border-[var(--line)]">
                        <td className="px-4 py-3 font-bold">{item.product_name || '—'}</td>
                        <td className="px-4 py-3">{item.batch_number || '—'}</td>
                        <td className="px-4 py-3">{item.available_quantity}</td>
                        <td className="px-4 py-3">{item.expiry_date ? new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeZone: 'Asia/Hebron' }).format(new Date(item.expiry_date)) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      ) : null}

      {activeTab === 'movements' ? (
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <TableHeader title="حركات المخزون" />
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-right text-sm">
              <thead className="sticky top-0 bg-[var(--muted)]">
                <tr className="border-b border-[var(--line)]">
                  <th className="px-4 py-3">الوقت</th>
                  <th className="px-4 py-3">الصنف</th>
                  <th className="px-4 py-3">النوع</th>
                  <th className="px-4 py-3">الكمية</th>
                  <th className="px-4 py-3">المرجع</th>
                  <th className="px-4 py-3">السبب</th>
                </tr>
              </thead>
              <tbody>
                {movementRows.map((item) => (
                  <tr key={item.id} className="border-b border-[var(--line)]">
                    <td className="px-4 py-3">{item.created_at ? new Intl.DateTimeFormat('ar-PS', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Hebron' }).format(new Date(item.created_at)) : '—'}</td>
                    <td className="px-4 py-3 font-bold">{item.product_name || '—'}</td>
                    <td className="px-4 py-3">{item.movement_type}</td>
                    <td className="px-4 py-3">{item.quantity}</td>
                    <td className="px-4 py-3">
                      {item.reference_type}
                      {item.reference_id ? ` #${item.reference_id}` : ''}
                    </td>
                    <td className="px-4 py-3">{item.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {activeTab === 'stocktaking' ? (
        <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] gap-4">
          <Card className="p-4">
            <div className="space-y-3">
              <select className="h-12 w-full rounded-2xl border border-[var(--line)] bg-white px-4" value={countType} onChange={(event) => setCountType(event.target.value as 'daily' | 'monthly')}>
                <option value="daily">جرد يومي</option>
                <option value="monthly">جرد شهري</option>
              </select>
              <Input type="datetime-local" value={countDate} onChange={(event) => setCountDate(event.target.value)} />
              <select className="h-12 w-full rounded-2xl border border-[var(--line)] bg-white px-4" value={countProductId} onChange={(event) => setCountProductId(event.target.value)}>
                <option value="">اختر المنتج للجرد</option>
                {(productsQuery.data ?? []).map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
              <Input type="number" step="0.001" min="0" placeholder="الكمية المعدودة" value={countQuantity} onChange={(event) => setCountQuantity(event.target.value)} />
              <Input placeholder="سبب الفرق / التسوية" value={countReason} onChange={(event) => setCountReason(event.target.value)} />
              <Button type="button" className="w-full" onClick={createCount} disabled={createCountMutation.isPending}>
                {createCountMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ جلسة جرد'}
              </Button>
            </div>
          </Card>

          <Card className="flex min-h-0 flex-col overflow-hidden p-0">
            <TableHeader title="تاريخ الجرد" />
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full text-right text-sm">
                <thead className="sticky top-0 bg-[var(--muted)]">
                  <tr className="border-b border-[var(--line)]">
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">النوع</th>
                    <th className="px-4 py-3">التاريخ</th>
                    <th className="px-4 py-3">الحالة</th>
                    <th className="px-4 py-3">إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {countsRows.map((item) => (
                    <tr key={item.id} className="border-b border-[var(--line)]">
                      <td className="px-4 py-3">#{item.id}</td>
                      <td className="px-4 py-3">{item.count_type === 'daily' ? 'يومي' : 'شهري'}</td>
                      <td className="px-4 py-3">{item.count_date ? new Intl.DateTimeFormat('ar-PS', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Hebron' }).format(new Date(item.count_date)) : '—'}</td>
                      <td className="px-4 py-3">{item.status}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          {item.status === 'draft' ? (
                            <Button type="button" variant="secondary" className="h-9 rounded-xl px-3" onClick={() => actionMutation.mutate({ id: item.id, action: 'submit' })}>
                              إرسال
                            </Button>
                          ) : null}
                          {item.status === 'submitted' ? (
                            <Button type="button" variant="secondary" className="h-9 rounded-xl px-3" onClick={() => actionMutation.mutate({ id: item.id, action: 'approve' })}>
                              اعتماد
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}
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
      <div className="mt-3 text-2xl font-black">{value}</div>
    </Card>
  )
}
