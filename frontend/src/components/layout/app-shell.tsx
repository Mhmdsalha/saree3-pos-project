import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { QrCode } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppView } from '@/App'
import { AppProviders } from '@/app/providers'
import { InvoicePanel } from '@/components/layout/invoice-panel'
import { ProductRequestDialog } from '@/components/layout/product-request-dialog'
import { Sidebar } from '@/components/layout/sidebar'
import { Topbar } from '@/components/layout/topbar'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { AttendancePage } from '@/features/attendance/attendance-page'
import { CashierProvider, useCashier } from '@/features/cashier/cashier-context'
import { CashierPage } from '@/features/cashier/cashier-page'
import { CheckoutDialog } from '@/features/cashier/checkout-dialog'
import { CustomersPage } from '@/features/customers/customers-page'
import { QrDialog } from '@/features/cashier/qr-dialog'
import { ExpiryPage } from '@/features/expiry/expiry-page'
import { InventoryPage } from '@/features/inventory/inventory-page'
import { InvoicesPage } from '@/features/invoices/invoices-page'
import { ProductsPage } from '@/features/products/products-page'
import { PurchasesPage } from '@/features/purchases/purchases-page'
import { ReturnsPage } from '@/features/returns/returns-page'
import { SettingsPage } from '@/features/settings/settings-page'
import { PlaceholderPage } from '@/features/shared/placeholder-page'
import { ShortcutsPage } from '@/features/shortcuts/shortcuts-page'
import { SuppliersPage } from '@/features/suppliers/suppliers-page'
import { UsersPage } from '@/features/users/users-page'
import { apiGet } from '@/lib/api-client'
import { publishNotice } from '@/lib/notice-center'
import { STOREFRONT_UPDATED_EVENT } from '@/lib/storefront'
import type { StoredSession } from '@/lib/auth'
import type { ProductAlertsReport } from '@/types/api'

const ReportsPage = lazy(() => import('@/features/reports/reports-page').then((module) => ({ default: module.ReportsPage })))

type AppShellProps = {
  activeView: AppView
  session: StoredSession
  onLogout: () => Promise<void> | void
  onViewChange: (view: AppView) => void
}

const pageTitles: Record<AppView, { title: string; subtitle: string }> = {
  cashier: { title: 'الكاشير', subtitle: 'بيع سريع وواضح مع نفس سير العمل الحالي.' },
  products: { title: 'المنتجات', subtitle: 'إدارة بيانات الأصناف الأساسية بشكل مباشر.' },
  suppliers: { title: 'الموردون', subtitle: 'متابعة الموردين وربطهم بالمشتريات.' },
  purchases: { title: 'المشتريات', subtitle: 'تسجيل الشراء وتحديث المخزون من نفس النظام.' },
  inventory: { title: 'المخزون', subtitle: 'الرصيد والحركات والجرد في شاشة واحدة.' },
  returns: { title: 'المرتجعات', subtitle: 'إرجاع آمن مرتبط بالفواتير والمخزون.' },
  invoices: { title: 'الفواتير', subtitle: 'مراجعة الفواتير والبحث فيها بسهولة.' },
  customers: { title: 'العملاء', subtitle: 'عرض العملاء المسجلين وحالة تفعيل تيليجرام.' },
  reports: { title: 'التقارير والتحليلات', subtitle: 'لوحة مؤشرات ورسوم ورؤى تشغيلية لقراءة أداء المتجر بسرعة.' },
  attendance: { title: 'الحضور', subtitle: 'متابعة ساعات الاتصال والحضور الشهري.' },
  expiry: { title: 'الصلاحية', subtitle: 'عرض الأصناف القريبة من الانتهاء أو المنتهية.' },
  shortcuts: { title: 'الاختصارات', subtitle: 'مرجع سريع لاختصارات الكيبورد داخل النظام.' },
  users: { title: 'المستخدمون', subtitle: 'إدارة الحسابات والصلاحيات من مكان واحد.' },
  settings: { title: 'الإعدادات', subtitle: 'ضبط الربط والطباعة وإعدادات النظام.' },
}

async function fetchManagerAlerts() {
  return apiGet<ProductAlertsReport>('/products/alerts')
}

async function fetchServerHealth() {
  return apiGet<{ status?: string }>('/health')
}

export function AppShell({ activeView, session, onLogout, onViewChange }: AppShellProps) {
  return (
    <AppProviders>
      <CashierProvider key={session.sessionToken}>
        <AppShellContent activeView={activeView} session={session} onLogout={onLogout} onViewChange={onViewChange} />
      </CashierProvider>
    </AppProviders>
  )
}

function AppShellContent({ activeView, session, onLogout, onViewChange }: AppShellProps) {
  const queryClient = useQueryClient()
  const meta = pageTitles[activeView]
  const roleLabel = session.user.role === 'cashier' ? 'كاشير' : session.user.role === 'supervisor' ? 'مشرف' : 'مدير'
  const [alertsDialogOpen, setAlertsDialogOpen] = useState(false)
  const [alertsPresented, setAlertsPresented] = useState(false)
  const usesPanelScroll =
    activeView === 'attendance' ||
    activeView === 'settings' ||
    activeView === 'purchases' ||
    activeView === 'shortcuts'
  const [productRequestBarcode, setProductRequestBarcode] = useState('')
  const [productRequestOpen, setProductRequestOpen] = useState(false)
  const [refreshPending, setRefreshPending] = useState(false)
  const [lastNonShortcutView, setLastNonShortcutView] = useState<AppView>(activeView === 'shortcuts' ? 'cashier' : activeView)
  const [browserOnline, setBrowserOnline] = useState(() => window.navigator.onLine)

  const alertsQuery = useQuery({
    queryKey: ['products', 'alerts'],
    queryFn: fetchManagerAlerts,
    enabled: session.user.role !== 'cashier',
    staleTime: 60_000,
  })

  const healthQuery = useQuery({
    queryKey: ['server-health'],
    queryFn: fetchServerHealth,
    retry: false,
    refetchInterval: browserOnline ? 30_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  })
  const refetchHealth = healthQuery.refetch

  useEffect(() => {
    const handleOnline = () => {
      setBrowserOnline(true)
      void refetchHealth()
    }
    const handleOffline = () => {
      setBrowserOnline(false)
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [refetchHealth])

  useEffect(() => {
    const handleStorefrontUpdated = () => {
      void queryClient.invalidateQueries({ queryKey: ['categories'] })
      void queryClient.invalidateQueries({ queryKey: ['products'] })
    }

    window.addEventListener(STOREFRONT_UPDATED_EVENT, handleStorefrontUpdated as EventListener)
    return () => {
      window.removeEventListener(STOREFRONT_UPDATED_EVENT, handleStorefrontUpdated as EventListener)
    }
  }, [queryClient])

  const alertCounts = alertsQuery.data?.counts
  const expiryAlerts = (alertCounts?.expired ?? 0) + (alertCounts?.near_expiry ?? 0)
  const totalAlerts = useMemo(
    () =>
      (alertCounts?.out_of_stock ?? 0) +
      (alertCounts?.low_stock ?? 0) +
      (alertCounts?.expired ?? 0) +
      (alertCounts?.near_expiry ?? 0),
    [alertCounts],
  )

  useEffect(() => {
    if (session.user.role === 'cashier') {
      return
    }
    if (alertsQuery.data && totalAlerts > 0 && !alertsPresented) {
      setAlertsDialogOpen(true)
      setAlertsPresented(true)
    }
  }, [alertsPresented, alertsQuery.data, session.user.role, totalAlerts])

  useEffect(() => {
    if (activeView !== 'shortcuts') {
      setLastNonShortcutView(activeView)
    }
  }, [activeView])

  useEffect(() => {
    if (session.user.role === 'cashier') return
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ barcode?: string }>).detail
      const barcode = String(detail?.barcode || '').trim()
      if (!barcode) return
      setProductRequestBarcode(barcode)
      setProductRequestOpen(true)
    }
    window.addEventListener('flowpos:add-product-request', handleRequest as EventListener)
    return () => window.removeEventListener('flowpos:add-product-request', handleRequest as EventListener)
  }, [session.user.role])

  const handleRefresh = async () => {
    if (refreshPending) return
    try {
      setRefreshPending(true)
      await queryClient.refetchQueries({ type: 'active' })
      publishNotice('تم تحديث البيانات بنجاح.', 'success')
    } catch {
      publishNotice('تعذر تحديث البيانات الآن.', 'error')
    } finally {
      setRefreshPending(false)
    }
  }

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName.toLowerCase()
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
    }

    const handleGlobalShortcuts = (event: KeyboardEvent) => {
      if (event.key === 'F1') {
        event.preventDefault()
        onViewChange('shortcuts')
        return
      }

      if (event.ctrlKey && event.code === 'KeyR') {
        event.preventDefault()
        void handleRefresh()
        return
      }

      if (event.ctrlKey && event.code === 'KeyF') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('flowpos:focus-search'))
        return
      }

      if (event.ctrlKey && event.code === 'KeyS') {
        if (isEditableTarget(event.target) || activeView === 'products') {
          event.preventDefault()
          window.dispatchEvent(new CustomEvent('flowpos:save-current-form'))
        }
        return
      }

      if (event.ctrlKey && event.code === 'KeyE' && activeView === 'products') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('flowpos:edit-selected-item'))
        return
      }

      if (event.ctrlKey && event.code === 'KeyT' && activeView === 'cashier') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('flowpos:telegram-action'))
      }
    }

    window.addEventListener('keydown', handleGlobalShortcuts)
    return () => window.removeEventListener('keydown', handleGlobalShortcuts)
  }, [activeView, onViewChange, refreshPending, session.user.role])

  const serverStatus = browserOnline && healthQuery.isSuccess ? 'online' : 'offline'

  return (
    <div className="h-screen overflow-hidden bg-[var(--app-bg)] text-[var(--text-strong)]">
      <div className="grid h-screen grid-cols-[220px_minmax(0,1fr)] gap-4 overflow-hidden p-4">
        <Sidebar activeView={activeView} role={session.user.role} onLogout={onLogout} onViewChange={onViewChange} />
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden">
          {activeView === 'cashier' ? (
            <CashierShell
              title={meta.title}
              subtitle={meta.subtitle}
              userName={session.user.name}
              roleLabel={roleLabel}
              serverStatus={serverStatus}
              onRefresh={handleRefresh}
              refreshPending={refreshPending}
            />
          ) : (
            <>
              <Topbar
                title={meta.title}
                subtitle={meta.subtitle}
                userName={session.user.name}
                roleLabel={roleLabel}
                serverStatus={serverStatus}
                onRefresh={handleRefresh}
                refreshPending={refreshPending}
              />
              <div className="grid min-h-0 gap-4 grid-cols-1">
                <main
                  data-app-main="content"
                  className={`h-full min-h-0 rounded-[28px] border border-[var(--line)] bg-[var(--app-bg)] p-4 shadow-none ${
                    usesPanelScroll ? 'overflow-y-auto overflow-x-hidden' : 'overflow-hidden'
                  }`}
                >
                  {activeView === 'products' ? (
                    <ProductsPage />
                  ) : activeView === 'suppliers' ? (
                    <SuppliersPage />
                  ) : activeView === 'purchases' ? (
                    <PurchasesPage />
                  ) : activeView === 'inventory' ? (
                    <InventoryPage onOpenExpiry={() => onViewChange('expiry')} />
                  ) : activeView === 'returns' ? (
                    <ReturnsPage />
                  ) : activeView === 'invoices' ? (
                    <InvoicesPage />
                  ) : activeView === 'customers' ? (
                    <CustomersPage />
                  ) : activeView === 'reports' ? (
                    <Suspense fallback={<PanelLoadingState label="جاري تحميل التقارير والتحليلات..." />}>
                      <ReportsPage />
                    </Suspense>
                  ) : activeView === 'attendance' ? (
                    <AttendancePage />
                  ) : activeView === 'expiry' ? (
                    <ExpiryPage />
                  ) : activeView === 'shortcuts' ? (
                    <ShortcutsPage onBack={() => onViewChange(lastNonShortcutView)} />
                  ) : activeView === 'users' ? (
                    <UsersPage />
                  ) : activeView === 'settings' ? (
                    <SettingsPage />
                  ) : (
                    <PlaceholderPage title={meta.title} subtitle={meta.subtitle} />
                  )}
                </main>
              </div>
            </>
          )}
        </div>
      </div>

      <Dialog open={alertsDialogOpen} onClose={() => setAlertsDialogOpen(false)} className="max-w-lg">
        <div className="space-y-5">
          <div className="text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[22px] bg-[var(--brand-gradient)] text-2xl font-black text-white shadow-[0_18px_34px_rgba(245,124,0,0.28)]">
              !
            </div>
            <h3 className="mt-4 text-2xl font-black">تنبيهات مهمة للمنتجات</h3>
            <p className="mt-2 text-sm leading-7 text-[var(--text-muted)]">يوجد تنبيهات مرتبطة بالمخزون أو الصلاحية تحتاج مراجعة قبل متابعة العمل.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <AlertCountCard label="نفد المخزون" value={alertCounts?.out_of_stock ?? 0} tone="red" />
            <AlertCountCard label="مخزون منخفض" value={alertCounts?.low_stock ?? 0} tone="amber" />
            <AlertCountCard label="صلاحية منتهية" value={alertCounts?.expired ?? 0} tone="red" />
            <AlertCountCard label="قريبة من الانتهاء" value={alertCounts?.near_expiry ?? 0} tone="amber" />
          </div>

          <div className="flex gap-3">
            <Button
              type="button"
              className="flex-1"
              onClick={() => {
                setAlertsDialogOpen(false)
                onViewChange(expiryAlerts > 0 ? 'expiry' : 'inventory')
              }}
            >
              {expiryAlerts > 0 ? 'فتح صفحة الصلاحية' : 'فتح صفحة المخزون'}
            </Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setAlertsDialogOpen(false)}>
              لاحقًا
            </Button>
          </div>
        </div>
      </Dialog>

      <ProductRequestDialog
        open={productRequestOpen}
        barcode={productRequestBarcode}
        onClose={() => {
          setProductRequestOpen(false)
          setProductRequestBarcode('')
        }}
      />
    </div>
  )
}

type CashierShellProps = {
  title: string
  subtitle: string
  userName: string
  roleLabel: string
  serverStatus: 'online' | 'offline'
  onRefresh: () => Promise<void>
  refreshPending: boolean
}

function PanelLoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[280px] items-center justify-center rounded-[24px] border border-dashed border-[var(--line)] bg-white/70 text-sm font-bold text-[var(--text-muted)]">
      {label}
    </div>
  )
}

function CashierShell({
  title,
  subtitle,
  userName,
  roleLabel,
  serverStatus,
  onRefresh,
  refreshPending,
}: CashierShellProps) {
  const { mobileReady, openQrDialog } = useCashier()

  return (
    <>
      <Topbar
        title={title}
        subtitle={subtitle}
        userName={userName}
        roleLabel={roleLabel}
        serverStatus={serverStatus}
        onRefresh={onRefresh}
        refreshPending={refreshPending}
        actions={
          <Button type="button" variant="secondary" className="h-10 rounded-2xl px-4" onClick={() => void openQrDialog()}>
            <QrCode className="h-4 w-4" />
            {mobileReady ? 'الموبايل متصل' : 'ربط الموبايل'}
          </Button>
        }
      />
      <div className="grid h-full min-h-0 gap-4 overflow-hidden grid-cols-[minmax(0,1fr)_520px]">
        <main className="h-full min-h-0 overflow-hidden rounded-[28px] border border-[var(--line)] bg-[var(--app-bg)] p-4 shadow-none">
          <CashierPage />
        </main>
        <InvoicePanel />
      </div>
      <CheckoutDialog />
      <QrDialog />
    </>
  )
}

function AlertCountCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'red' | 'amber'
}) {
  const toneClass = tone === 'red' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700'
  return (
    <div className={`rounded-[22px] border px-4 py-4 ${toneClass}`}>
      <div className="text-sm font-bold">{label}</div>
      <div className="mt-2 text-3xl font-black">{value}</div>
    </div>
  )
}
