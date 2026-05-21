import { useState, type ComponentType } from 'react'
import type { AppView } from '@/App'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { SYSTEM_LOGO_DARK_URL } from '@/lib/system-branding'
import { SYSTEM_LOGO_LIGHT_URL } from '@/lib/system-branding'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/types/api'
import {
  BadgePercent,
  ClipboardList,
  Clock3,
  Keyboard,
  LogOut,
  Package,
  Receipt,
  ReceiptText,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Warehouse,
} from 'lucide-react'

type SidebarProps = {
  activeView: AppView
  role: UserRole
  onLogout: () => Promise<void> | void
  onViewChange: (view: AppView) => void
}

const navItems: Array<{ view: AppView; label: string; icon: ComponentType<{ className?: string }>; adminOnly?: boolean }> = [
  { view: 'cashier', label: 'الكاشير', icon: ShoppingCart },
  { view: 'products', label: 'المنتجات', icon: Package, adminOnly: true },
  { view: 'suppliers', label: 'الموردون', icon: Truck, adminOnly: true },
  { view: 'purchases', label: 'المشتريات', icon: ClipboardList, adminOnly: true },
  { view: 'inventory', label: 'المخزون', icon: Warehouse, adminOnly: true },
  { view: 'returns', label: 'المرتجعات', icon: Receipt },
  { view: 'invoices', label: 'الفواتير', icon: ReceiptText },
  { view: 'customers', label: 'العملاء', icon: Users, adminOnly: true },
  { view: 'reports', label: 'التقارير والتحليلات', icon: BadgePercent, adminOnly: true },
  { view: 'attendance', label: 'الحضور', icon: Clock3, adminOnly: true },
  { view: 'shortcuts', label: 'الاختصارات', icon: Keyboard },
  { view: 'users', label: 'المستخدمون', icon: Users, adminOnly: true },
  { view: 'settings', label: 'الإعدادات', icon: Settings, adminOnly: true },
]

export function Sidebar({ activeView, role, onLogout, onViewChange }: SidebarProps) {
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  return (
    <>
      <aside className="sticky top-4 flex h-[calc(100vh-2rem)] flex-col rounded-[28px] border border-white/8 bg-[var(--sidebar)] px-3 py-4 text-white shadow-[0_22px_60px_rgba(15,23,42,0.35)]">
        <div className="mb-4 flex w-full items-center justify-center">
          <img src={SYSTEM_LOGO_LIGHT_URL} alt="شعار سريع" className="sidebar-system-logo" />
        </div>

        <Badge className="mb-4 self-center bg-white/10 text-white">{role === 'cashier' ? 'كاشير' : 'إدارة'}</Badge>

        <nav className="sidebar-scrollbar flex w-full flex-1 flex-col gap-2 overflow-y-auto pr-1">
          {navItems
            .filter((item) => !(item.adminOnly && role === 'cashier'))
            .map((item) => {
              const Icon = item.icon
              return (
                <Button
                  key={item.view}
                  type="button"
                  variant="ghost"
                  onClick={() => onViewChange(item.view)}
                  className={cn(
                    'h-12 w-full justify-start gap-3 rounded-2xl border border-transparent bg-transparent px-4 text-white/72 hover:border-white/10 hover:bg-white/8 hover:text-white',
                    activeView === item.view && 'border-white/10 bg-white/12 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]',
                  )}
                  title={item.label}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  <span className="truncate text-sm font-semibold">{item.label}</span>
                </Button>
              )
            })}
        </nav>

        <Button
          type="button"
          variant="ghost"
          onClick={() => setLogoutDialogOpen(true)}
          className="mt-3 h-12 w-full justify-start gap-3 rounded-2xl px-4 text-white/72 hover:bg-white/8 hover:text-white"
        >
          <LogOut className="h-5 w-5 shrink-0" />
          <span className="text-sm font-semibold">تسجيل الخروج</span>
        </Button>
      </aside>

      <Dialog open={logoutDialogOpen} onClose={loggingOut ? () => undefined : () => setLogoutDialogOpen(false)} className="max-w-md">
        <div className="space-y-4 text-center">
          <img src={SYSTEM_LOGO_DARK_URL} alt="شعار سريع" className="mx-auto h-16 w-auto object-contain" />
          <div>
            <h3 className="text-2xl font-black">تسجيل الخروج</h3>
            <p className="mt-2 text-sm leading-7 text-[var(--text-muted)]">
              سيتم إغلاق الجلسة الحالية وإعادتك إلى شاشة الدخول. هل تريد المتابعة؟
            </p>
          </div>
          <div className="flex gap-3">
            <Button
              type="button"
              className="flex-1"
              disabled={loggingOut}
              onClick={async () => {
                setLoggingOut(true)
                try {
                  await onLogout()
                } finally {
                  setLoggingOut(false)
                  setLogoutDialogOpen(false)
                }
              }}
            >
              {loggingOut ? 'جارٍ الخروج...' : 'تسجيل الخروج'}
            </Button>
            <Button type="button" variant="secondary" className="flex-1" disabled={loggingOut} onClick={() => setLogoutDialogOpen(false)}>
              إلغاء
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
