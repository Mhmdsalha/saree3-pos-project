import { type ReactNode, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button as HeroButton, Chip, Spinner } from '@heroui/react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiGet } from '@/lib/api-client'
import { formatMoneyWithCurrency } from '@/lib/storefront'
import type { Category, ReportsDashboardAlertItem, ReportsDashboardCategoryPoint, ReportsDashboardProductPoint, ReportsDashboardResponse } from '@/types/api'

type DatePreset = 'today' | 'week' | 'month' | 'custom'

type ReportFilters = {
  preset: DatePreset
  dateFrom: string
  dateTo: string
  categoryId: string
  paymentMethod: string
}

const PAYMENT_METHOD_OPTIONS = [
  { value: '', label: 'كل طرق الدفع' },
  { value: 'cash', label: 'نقدًا' },
  { value: 'card', label: 'بطاقة' },
  { value: 'digital', label: 'تحويل / رقمي' },
]

const CHART_COLORS = [
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#ea580c',
  '#db2777',
  '#65a30d',
  '#4f46e5',
  '#be123c',
  '#0d9488',
  '#ca8a04',
  '#9333ea',
  '#0284c7',
  '#c2410c',
  '#15803d',
]

const PAYMENT_METHOD_COLORS: Record<string, string> = {
  cash: '#16a34a',
  card: '#2563eb',
  digital: '#7c3aed',
  unknown: '#64748b',
}

function stableColorForKey(key: string | number | null | undefined, index = 0) {
  const source = String(key ?? `item-${index}`)
  let hash = 0
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0
  }
  return CHART_COLORS[hash % CHART_COLORS.length]
}

function paymentColor(method: string | null | undefined, index = 0) {
  const normalized = String(method || 'unknown').trim().toLowerCase()
  return PAYMENT_METHOD_COLORS[normalized] || stableColorForKey(normalized, index)
}

async function fetchDashboard(filters: ReportFilters) {
  const params = new URLSearchParams()
  params.set('preset', filters.preset)
  if (filters.preset === 'month') {
    params.set('date_from', filters.dateFrom.slice(0, 7))
  } else if (filters.preset === 'custom') {
    params.set('date_from', filters.dateFrom)
    params.set('date_to', filters.dateTo)
  } else if (filters.dateFrom) {
    params.set('date_from', filters.dateFrom)
  }
  if (filters.categoryId) params.set('category_id', filters.categoryId)
  if (filters.paymentMethod) params.set('payment_method', filters.paymentMethod)
  return apiGet<ReportsDashboardResponse>(`/reports/dashboard?${params.toString()}`)
}

async function fetchCategories() {
  return apiGet<Category[]>('/categories')
}

export function ReportsPage() {
  const [filters, setFilters] = useState<ReportFilters>(() => ({
    preset: 'month',
    dateFrom: monthKey(),
    dateTo: todayKey(),
    categoryId: '',
    paymentMethod: '',
  }))

  const categoriesQuery = useQuery({ queryKey: ['categories'], queryFn: fetchCategories, staleTime: 60_000 })
  const dashboardQuery = useQuery({
    queryKey: ['reports', 'dashboard', filters],
    queryFn: () => fetchDashboard(filters),
  })

  const dashboard = dashboardQuery.data
  const topProducts = dashboard?.tables.top_products ?? []
  const categoryPerformance = dashboard?.tables.category_performance ?? []
  const alerts = dashboard?.alerts

  const summaryChips = useMemo(() => {
    if (!dashboard) return []
    const chips = [dashboard.period.label]
    if (filters.categoryId) {
      const category = (categoriesQuery.data ?? []).find((item) => String(item.id) === filters.categoryId)
      if (category) chips.push(`الفئة: ${category.name}`)
    }
    if (filters.paymentMethod) {
      const payment = PAYMENT_METHOD_OPTIONS.find((item) => item.value === filters.paymentMethod)
      if (payment) chips.push(`الدفع: ${payment.label}`)
    }
    return chips
  }, [categoriesQuery.data, dashboard, filters.categoryId, filters.paymentMethod])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto overflow-x-hidden rounded-[34px] bg-slate-100/55 p-3 pb-7 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] lg:p-4 lg:pb-8 lg:pl-5">
      <Card variant="glass" className="rounded-[30px] p-5">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="space-y-2">
            <h2 className="text-3xl font-black">التقارير والتحليلات</h2>
            <p className="max-w-3xl text-sm leading-7 text-[var(--text-muted)]">
              لوحة تحليلات موحدة مبنية على مبيعات المتجر ومرتجعاته وحالة المخزون، لتساعد المدير على اتخاذ القرار بسرعة
              وبدقة.
            </p>
            <div className="flex flex-wrap gap-2">
              {summaryChips.map((item) => (
                <Chip key={item} className="bg-orange-50 text-orange-700">
                  {item}
                </Chip>
              ))}
            </div>
          </div>

          <div className="w-full max-w-[760px] space-y-3 xl:w-[760px]">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <PresetButton
                active={filters.preset === 'today'}
                onClick={() => setFilters((current) => ({ ...current, preset: 'today', dateFrom: todayKey(), dateTo: todayKey() }))}
              >
                اليوم
              </PresetButton>
              <PresetButton
                active={filters.preset === 'week'}
                onClick={() => setFilters((current) => ({ ...current, preset: 'week', dateFrom: todayKey(), dateTo: todayKey() }))}
              >
                هذا الأسبوع
              </PresetButton>
              <PresetButton
                active={filters.preset === 'month'}
                onClick={() => setFilters((current) => ({ ...current, preset: 'month', dateFrom: monthKey(), dateTo: todayKey() }))}
              >
                هذا الشهر
              </PresetButton>
              <PresetButton
                active={filters.preset === 'custom'}
                onClick={() => setFilters((current) => ({ ...current, preset: 'custom', dateFrom: todayKey(), dateTo: todayKey() }))}
              >
                فترة مخصصة
              </PresetButton>
            </div>

            <div className="grid gap-2 lg:grid-cols-[minmax(190px,0.85fr)_minmax(0,1.15fr)]">
              {filters.preset === 'custom' ? (
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    value={filters.dateFrom}
                    onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))}
                  />
                  <Input
                    type="date"
                    value={filters.dateTo}
                    onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))}
                  />
                </div>
              ) : (
                <Input type={filters.preset === 'month' ? 'month' : 'date'} value={filters.dateFrom} readOnly />
              )}
              <div className="grid grid-cols-2 gap-2">
                <select
                  className="h-12 rounded-2xl border border-[var(--line)] bg-white/95 px-4 shadow-sm"
                  value={filters.categoryId}
                  onChange={(event) => setFilters((current) => ({ ...current, categoryId: event.target.value }))}
                >
                  <option value="">كل الفئات</option>
                  {(categoriesQuery.data ?? []).map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <select
                  className="h-12 rounded-2xl border border-[var(--line)] bg-white/95 px-4 shadow-sm"
                  value={filters.paymentMethod}
                  onChange={(event) => setFilters((current) => ({ ...current, paymentMethod: event.target.value }))}
                >
                  {PAYMENT_METHOD_OPTIONS.map((option) => (
                    <option key={option.value || 'all'} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {dashboardQuery.isLoading ? (
        <LoadingState />
      ) : dashboardQuery.isError ? (
        <ErrorState message={dashboardQuery.error instanceof Error ? dashboardQuery.error.message : 'تعذر تحميل التقارير.'} />
      ) : dashboard ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
            <KpiCard title="إجمالي المبيعات" value={formatMoneyWithCurrency(dashboard.kpis.gross_sales)} note="قبل خصم المرتجعات" />
            <KpiCard title="صافي المبيعات" value={formatMoneyWithCurrency(dashboard.kpis.net_sales)} note="بعد خصم المرتجعات" accent />
            <KpiCard title="إجمالي المرتجعات" value={formatMoneyWithCurrency(dashboard.kpis.total_returns)} note={`${dashboard.kpis.return_count} عملية`} warning />
            <KpiCard title="عدد الفواتير" value={String(dashboard.kpis.invoice_count)} note="فواتير مكتملة ضمن الفترة" />
            <KpiCard title="متوسط الفاتورة" value={formatMoneyWithCurrency(dashboard.kpis.average_invoice_value)} note="صافي المبيعات ÷ عدد الفواتير" />
            <KpiCard
              title="أفضل منتج"
              value={dashboard.kpis.top_selling_product_name || 'لا توجد بيانات'}
              note={
                dashboard.kpis.top_selling_product_qty != null
                  ? `بصافي كمية ${formatQuantity(dashboard.kpis.top_selling_product_qty)}`
                  : 'سيظهر عند توفر مبيعات'
              }
            />
            <KpiCard title="منخفضة المخزون" value={String(dashboard.kpis.low_stock_products_count)} note="تشمل النافد والمنخفض" />
            <KpiCard title="قريبة من الانتهاء" value={String(dashboard.kpis.near_expiry_products_count)} note="خلال 30 يومًا" />
          </div>

          <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.95fr)]">
            <ChartCard
              title="المبيعات عبر الزمن"
              subtitle="يعرض إجمالي وصافي المبيعات يوميًا ضمن الفترة المحددة."
              contentClassName="h-[340px]"
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dashboard.series.sales_over_time}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e6edf7" />
                  <XAxis dataKey="label" stroke="#708197" />
                  <YAxis stroke="#708197" />
                  <RechartsTooltip formatter={(value) => formatMoneyWithCurrency(Number(value ?? 0))} />
                  <Legend />
                  <Line type="monotone" dataKey="gross_sales" name="إجمالي المبيعات" stroke="#f57c00" strokeWidth={3} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="net_sales" name="صافي المبيعات" stroke="#0f766e" strokeWidth={3} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <Card variant="glass" className="space-y-4 rounded-[28px] p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-black">رؤى وتحليلات مهمة</div>
                  <div className="text-sm text-[var(--text-muted)]">استنتاجات rule-based مبنية على بيانات الفترة الحالية فقط.</div>
                </div>
                <div title="تظهر الرؤى فقط عندما تكون البيانات كافية وواضحة.">
                  <Chip className="bg-orange-50 text-orange-700">تحليل تشغيلي</Chip>
                </div>
              </div>
              {dashboard.insights.length ? (
                <div className="grid gap-3">
                  {dashboard.insights.map((insight) => (
                    <Card key={insight.id} variant="glass-subtle" className="rounded-[22px] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-base font-black">{insight.title}</div>
                        <Chip className={chipClassForTone(insight.tone)}>{toneLabel(insight.tone)}</Chip>
                      </div>
                      <div className="mt-2 text-sm leading-7 text-[var(--text-strong)]">{insight.body}</div>
                      <div className="mt-2 text-xs leading-6 text-[var(--text-muted)]">{insight.basis}</div>
                    </Card>
                  ))}
                </div>
              ) : (
                <EmptyPanel message="لا توجد رؤى كافية لهذه الفترة. وسّع الفترة أو أزل بعض الفلاتر لعرض تحليل أوسع." />
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ChartCard title="صافي المبيعات مقابل المرتجعات" subtitle="مقارنة يومية توضح تأثير المرتجعات على الأداء." contentClassName="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dashboard.series.returns_vs_sales}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e6edf7" />
                  <XAxis dataKey="label" stroke="#708197" />
                  <YAxis stroke="#708197" />
                  <RechartsTooltip formatter={(value) => formatMoneyWithCurrency(Number(value ?? 0))} />
                  <Legend />
                  <Bar dataKey="net_sales" name="صافي المبيعات" fill="#f57c00" radius={[8, 8, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="returns" name="المرتجعات" fill="#ef4444" radius={[8, 8, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="أفضل 10 منتجات" subtitle="الترتيب هنا حسب صافي الكمية بعد خصم المرتجعات." contentClassName="h-[320px]">
              {dashboard.series.top_products.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dashboard.series.top_products} layout="vertical" margin={{ right: 16, left: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e6edf7" />
                    <XAxis type="number" stroke="#708197" />
                    <YAxis dataKey="name" type="category" width={120} stroke="#708197" />
                    <RechartsTooltip formatter={(value) => formatQuantity(Number(value ?? 0))} />
                    <Bar dataKey="net_qty" name="صافي الكمية" radius={[0, 8, 8, 0]} isAnimationActive={false}>
                      {dashboard.series.top_products.map((entry, index) => (
                        <Cell key={entry.product_id || entry.name} fill={stableColorForKey(entry.product_id || entry.name, index)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyPanel message="لا توجد مبيعات كافية لعرض المنتجات الأعلى أداءً في هذه الفترة." />
              )}
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <ChartCard title="أداء الفئات" subtitle="صافي الإيراد لكل فئة خلال الفترة المحددة." contentClassName="h-[300px]">
              {dashboard.series.category_performance.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dashboard.series.category_performance}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e6edf7" />
                    <XAxis dataKey="category_name" stroke="#708197" />
                    <YAxis stroke="#708197" />
                    <RechartsTooltip formatter={(value) => formatMoneyWithCurrency(Number(value ?? 0))} />
                    <Bar dataKey="net_revenue" name="صافي الإيراد" radius={[8, 8, 0, 0]} isAnimationActive={false}>
                      {dashboard.series.category_performance.map((entry, index) => (
                        <Cell key={entry.category_id || entry.category_name} fill={stableColorForKey(entry.category_id || entry.category_name, index)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyPanel message="لا توجد بيانات كافية لعرض أداء الفئات." />
              )}
            </ChartCard>

            <ChartCard title="طرق الدفع" subtitle="توزيع المبيعات على طرق الدفع ضمن الفترة." contentClassName="h-[300px]">
              {dashboard.series.payment_methods.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={dashboard.series.payment_methods}
                      dataKey="amount"
                      nameKey="label"
                      outerRadius={95}
                      innerRadius={52}
                      paddingAngle={2}
                      isAnimationActive={false}
                    >
                      {dashboard.series.payment_methods.map((entry, index) => (
                        <Cell key={entry.payment_method} fill={paymentColor(entry.payment_method, index)} />
                      ))}
                    </Pie>
                    <Legend />
                    <RechartsTooltip formatter={(value) => formatMoneyWithCurrency(Number(value ?? 0))} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyPanel message="لا توجد عمليات بيع ضمن هذه الفترة لعرض طرق الدفع." />
              )}
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <ChartCard title="النشاط حسب الساعة" subtitle="يساعد على معرفة ساعات الذروة اليومية." contentClassName="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dashboard.series.hourly_sales}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e6edf7" />
                  <XAxis dataKey="label" stroke="#708197" interval={1} angle={-20} textAnchor="end" height={56} />
                  <YAxis stroke="#708197" />
                  <RechartsTooltip formatter={(value) => formatMoneyWithCurrency(Number(value ?? 0))} />
                  <Bar dataKey="gross_sales" name="إجمالي المبيعات" fill="#f57c00" radius={[8, 8, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <Card variant="glass" className="rounded-[28px] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-black">تنبيهات المخزون والصلاحية</div>
                  <div className="text-sm text-[var(--text-muted)]">ملخص سريع للعناصر التي تحتاج متابعة تشغيلية.</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Chip className="bg-red-50 text-red-700">نافد: {alerts?.out_of_stock_count ?? 0}</Chip>
                  <Chip className="bg-amber-50 text-amber-700">منخفض: {alerts?.low_stock_count ?? 0}</Chip>
                  <Chip className="bg-orange-50 text-orange-700">قريب الانتهاء: {alerts?.near_expiry_count ?? 0}</Chip>
                </div>
              </div>

              <div className="mt-4 grid gap-3">
                <AlertSection title="أولوية المخزون" items={alerts?.low_stock ?? []} emptyMessage="لا توجد منتجات منخفضة أو نافدة ضمن الفلتر الحالي." />
                <AlertSection title="أولوية الصلاحية" items={alerts?.near_expiry ?? []} emptyMessage="لا توجد منتجات قريبة من الانتهاء ضمن الفلتر الحالي." />
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <TableCard title="أهم المنتجات" subtitle="صافي الكمية والإيراد بعد خصم المرتجعات.">
              <ProductsTable items={topProducts} />
            </TableCard>
            <TableCard title="الفئات وطرق الدفع" subtitle="ملخص عملي للمراجعة السريعة.">
              <div className="grid gap-4">
                <CategoryTable items={categoryPerformance} />
                <PaymentMethodsTable items={dashboard.tables.payment_methods} />
              </div>
            </TableCard>
          </div>
        </>
      ) : (
        <EmptyPanel message="لا توجد بيانات لهذه الفترة الحالية." />
      )}
    </div>
  )
}

function LoadingState() {
  return (
    <Card variant="glass" className="rounded-[28px] p-8">
      <div className="flex min-h-[260px] flex-col items-center justify-center gap-4 text-center">
        <Spinner color="warning" size="lg" />
        <div className="text-lg font-black">جارٍ تحليل البيانات...</div>
        <div className="text-sm text-[var(--text-muted)]">نجهز لك لوحة التقارير اعتمادًا على الفترة والفلاتر الحالية.</div>
      </div>
    </Card>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <Card variant="glass" className="rounded-[28px] p-8">
      <div className="space-y-2 text-center">
        <div className="text-2xl font-black text-red-700">تعذر تحميل التقارير</div>
        <div className="text-sm text-[var(--text-muted)]">{message}</div>
      </div>
    </Card>
  )
}

function KpiCard({
  title,
  value,
  note,
  accent,
  warning,
}: {
  title: string
  value: string
  note: string
  accent?: boolean
  warning?: boolean
}) {
  const colorClass = accent ? 'text-[var(--brand)]' : warning ? 'text-red-600' : 'text-[var(--text-strong)]'
  return (
    <Card variant="glass" className="rounded-[26px] p-4">
      <div className="text-sm text-[var(--text-muted)]">{title}</div>
      <div className={`mt-3 text-2xl font-black ${colorClass}`}>{value}</div>
      <div className="mt-2 text-xs leading-6 text-[var(--text-muted)]">{note}</div>
    </Card>
  )
}

function PresetButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <HeroButton
      onPress={onClick}
      variant={active ? 'primary' : 'outline'}
      className={
        active
          ? 'h-11 min-w-0 rounded-2xl bg-[var(--brand)] px-3 font-bold text-white shadow-[0_12px_26px_rgba(245,124,0,0.25)]'
          : 'h-11 min-w-0 rounded-2xl border-[var(--line)] bg-white/80 px-3 font-bold text-[var(--text-strong)]'
      }
    >
      {children}
    </HeroButton>
  )
}

function ChartCard({
  title,
  subtitle,
  children,
  contentClassName,
}: {
  title: string
  subtitle: string
  children: ReactNode
  contentClassName?: string
}) {
  return (
    <Card variant="glass" className="rounded-[28px] p-4">
      <div className="mb-4">
        <div className="text-lg font-black">{title}</div>
        <div className="text-sm text-[var(--text-muted)]">{subtitle}</div>
      </div>
      <div className={contentClassName}>{children}</div>
    </Card>
  )
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="flex min-h-[180px] items-center justify-center rounded-[22px] border border-dashed border-[var(--line)] bg-white/70 px-6 py-8 text-center text-sm leading-7 text-[var(--text-muted)]">
      {message}
    </div>
  )
}

function AlertSection({
  title,
  items,
  emptyMessage,
}: {
  title: string
  items: ReportsDashboardAlertItem[]
  emptyMessage: string
}) {
  return (
    <Card className="rounded-[24px] p-4">
      <div className="mb-3 text-sm font-black">{title}</div>
      {items.length ? (
        <div className="grid gap-2">
          {items.map((item) => (
            <div key={`${title}-${item.id}`} className="rounded-[18px] border border-[var(--line)] bg-[var(--muted)] px-3 py-3">
              <div className="font-bold">{item.name}</div>
              <div className="mt-1 text-xs text-[var(--text-muted)]">
                {item.stock != null ? `المخزون ${formatQuantity(item.stock)}` : ''}
                {item.min_stock != null ? ` • الحد الأدنى ${formatQuantity(item.min_stock)}` : ''}
                {item.days_left != null ? ` • متبقي ${item.days_left} يوم` : ''}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-[var(--text-muted)]">{emptyMessage}</div>
      )}
    </Card>
  )
}

function TableCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <Card className="overflow-hidden rounded-[28px] p-0">
      <div className="border-b border-[var(--line)] px-4 py-4">
        <div className="text-lg font-black">{title}</div>
        <div className="text-sm text-[var(--text-muted)]">{subtitle}</div>
      </div>
      <div className="p-4">{children}</div>
    </Card>
  )
}

function ProductsTable({ items }: { items: ReportsDashboardProductPoint[] }) {
  if (!items.length) {
    return <EmptyPanel message="لا توجد بيانات منتجات كافية لعرض الجدول." />
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-[640px] w-full text-right text-sm">
        <thead className="bg-[var(--muted)]">
          <tr className="border-b border-[var(--line)]">
            <th className="px-4 py-3">المنتج</th>
            <th className="px-4 py-3">الفئة</th>
            <th className="px-4 py-3">صافي الكمية</th>
            <th className="px-4 py-3">صافي الإيراد</th>
            <th className="px-4 py-3">المخزون</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.product_id} className="border-b border-[var(--line)]">
              <td className="px-4 py-3 font-bold">{item.name}</td>
              <td className="px-4 py-3">{item.category_name || 'غير مصنف'}</td>
              <td className="px-4 py-3">{formatQuantity(item.net_qty)}</td>
              <td className="px-4 py-3 font-bold text-[var(--brand)]">{formatMoneyWithCurrency(item.net_revenue)}</td>
              <td className="px-4 py-3">{item.stock != null ? formatQuantity(item.stock) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CategoryTable({ items }: { items: ReportsDashboardCategoryPoint[] }) {
  if (!items.length) {
    return <EmptyPanel message="لا توجد بيانات فئات كافية لهذه الفترة." />
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-right text-sm">
        <thead className="bg-[var(--muted)]">
          <tr className="border-b border-[var(--line)]">
            <th className="px-4 py-3">الفئة</th>
            <th className="px-4 py-3">صافي الكمية</th>
            <th className="px-4 py-3">صافي الإيراد</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.category_id ?? 'na'}-${item.category_name}`} className="border-b border-[var(--line)]">
              <td className="px-4 py-3 font-bold">{item.category_name}</td>
              <td className="px-4 py-3">{formatQuantity(item.net_qty)}</td>
              <td className="px-4 py-3">{formatMoneyWithCurrency(item.net_revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PaymentMethodsTable({
  items,
}: {
  items: ReportsDashboardResponse['tables']['payment_methods']
}) {
  if (!items.length) {
    return <EmptyPanel message="لا توجد بيانات طرق دفع لعرضها." />
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-right text-sm">
        <thead className="bg-[var(--muted)]">
          <tr className="border-b border-[var(--line)]">
            <th className="px-4 py-3">طريقة الدفع</th>
            <th className="px-4 py-3">عدد العمليات</th>
            <th className="px-4 py-3">القيمة</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.payment_method} className="border-b border-[var(--line)]">
              <td className="px-4 py-3 font-bold">{item.label}</td>
              <td className="px-4 py-3">{item.count}</td>
              <td className="px-4 py-3">{formatMoneyWithCurrency(item.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function toneLabel(tone: string) {
  if (tone === 'positive') return 'إيجابي'
  if (tone === 'warning') return 'تنبيه'
  return 'معلومة'
}

function chipClassForTone(tone: string) {
  if (tone === 'positive') return 'bg-emerald-50 text-emerald-700'
  if (tone === 'warning') return 'bg-amber-50 text-amber-700'
  return 'bg-sky-50 text-sky-700'
}

function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(2)
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())
}

function monthKey() {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    timeZone: 'Asia/Jerusalem',
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value
      return acc
    }, {})
  return `${parts.year}-${parts.month}`
}
