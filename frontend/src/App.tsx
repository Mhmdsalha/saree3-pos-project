import { useCallback, useEffect, useState } from 'react'
import { AppShell } from '@/components/layout/app-shell'
import { ToastStack } from '@/components/ui/toast-stack'
import { LoginPage } from '@/features/auth/login-page'
import { getStoredUser, logoutStoredSession, type StoredSession } from '@/lib/auth'
import { useNoticeCenter } from '@/lib/notice-center'
import { primeStorefrontBranding, STOREFRONT_UPDATED_EVENT } from '@/lib/storefront'
import type { UserRole } from '@/types/api'

export type AppView =
  | 'cashier'
  | 'products'
  | 'suppliers'
  | 'purchases'
  | 'inventory'
  | 'returns'
  | 'invoices'
  | 'customers'
  | 'reports'
  | 'attendance'
  | 'expiry'
  | 'shortcuts'
  | 'users'
  | 'settings'

const ADMIN_ONLY_VIEWS: AppView[] = [
  'reports',
  'attendance',
  'expiry',
  'users',
  'products',
  'suppliers',
  'purchases',
  'inventory',
  'customers',
]

export default function App() {
  const [session, setSession] = useState<StoredSession | null>(null)
  const [activeView, setActiveView] = useState<AppView>('cashier')
  const [, setStorefrontRevision] = useState(0)
  const { notices, pushNotice } = useNoticeCenter()

  useEffect(() => {
    setSession(getStoredUser())
    const refreshStorefront = () => void primeStorefrontBranding()
    refreshStorefront()

    const interval = window.setInterval(refreshStorefront, 30_000)
    const handleFocus = () => refreshStorefront()
    const handleOnline = () => refreshStorefront()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshStorefront()
    }
    const handleStorefrontUpdated = () => {
      setStorefrontRevision((current) => current + 1)
    }

    window.addEventListener('focus', handleFocus)
    window.addEventListener('online', handleOnline)
    window.addEventListener(STOREFRONT_UPDATED_EVENT, handleStorefrontUpdated as EventListener)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener(STOREFRONT_UPDATED_EVENT, handleStorefrontUpdated as EventListener)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  const handleViewChange = (nextView: AppView, role?: UserRole) => {
    if (role === 'cashier' && ADMIN_ONLY_VIEWS.includes(nextView)) {
      pushNotice('هذه الصفحة مخصّصة للمدير أو المشرف فقط.', 'warning')
      return
    }
    setActiveView(nextView)
  }

  const handleLogin = useCallback(
    (nextSession: StoredSession) => {
      setSession(nextSession)
      setActiveView('cashier')
      pushNotice(`أهلاً ${nextSession.user.name}`, 'success')
    },
    [pushNotice],
  )

  if (!session) {
    return (
      <>
        <ToastStack notices={notices} />
        <LoginPage onLogin={handleLogin} onNotice={pushNotice} />
      </>
    )
  }

  return (
    <>
      <ToastStack notices={notices} />
      <AppShell
        activeView={activeView}
        session={session}
        onLogout={async () => {
          await logoutStoredSession(session)
          setActiveView('cashier')
          setSession(null)
          pushNotice('تم تسجيل الخروج بنجاح.', 'success')
        }}
        onViewChange={(nextView) => handleViewChange(nextView, session.user.role)}
      />
    </>
  )
}
