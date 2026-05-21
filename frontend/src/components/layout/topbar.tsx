import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SYSTEM_BRAND_NAME, SYSTEM_LOGO_DARK_URL } from '@/lib/system-branding'
import { getStoredStoreLogoUrl, getStoredStoreTypeLabel } from '@/lib/storefront'
import { APP_TIME_ZONE } from '@/lib/time'

type ServerStatus = 'online' | 'offline'

type TopbarProps = {
  title: string
  subtitle: string
  userName: string
  roleLabel: string
  serverStatus?: ServerStatus
  onRefresh?: () => Promise<void> | void
  refreshPending?: boolean
  actions?: ReactNode
}

function serverBadgeClass(status: ServerStatus) {
  if (status === 'online') return 'bg-emerald-50 text-emerald-700'
  return 'bg-red-50 text-red-700'
}

function serverBadgeLabel(status: ServerStatus) {
  if (status === 'online') return 'متصل'
  return 'غير متصل (وضع أوفلاين)'
}

export function Topbar({
  title,
  subtitle,
  userName,
  roleLabel,
  serverStatus = 'online',
  onRefresh,
  refreshPending = false,
  actions,
}: TopbarProps) {
  const [clock, setClock] = useState('')
  const storeTypeLabel = getStoredStoreTypeLabel()
  const storeLogoUrl = getStoredStoreLogoUrl()
  const [showStoreLogo, setShowStoreLogo] = useState(Boolean(storeLogoUrl))

  useEffect(() => {
    const formatter = new Intl.DateTimeFormat('ar-PS', {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: APP_TIME_ZONE,
    })

    setClock(formatter.format(new Date()))
    const timer = window.setInterval(() => setClock(formatter.format(new Date())), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setShowStoreLogo(Boolean(storeLogoUrl))
  }, [storeLogoUrl])

  return (
    <header className="flex items-center justify-between rounded-[28px] border border-[var(--line)] bg-[var(--app-bg)] px-5 py-4 shadow-none">
      <div className="flex items-center gap-3">
        <Button type="button" variant="secondary" className="h-10 rounded-2xl px-4" onClick={onRefresh} disabled={refreshPending}>
          <RefreshCw className={`h-4 w-4 ${refreshPending ? 'animate-spin' : ''}`} />
          تحديث
        </Button>
        <Badge className={`h-10 rounded-2xl px-4 ${serverBadgeClass(serverStatus)}`}>{serverBadgeLabel(serverStatus)}</Badge>
        {actions}
      </div>
      <div className="text-center">
        <h1 className="text-xl font-black tracking-tight">{title}</h1>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{subtitle}</p>
        {storeTypeLabel ? (
          <div className="mt-2">
            <Badge className="rounded-2xl bg-orange-50 px-3 py-1 text-xs text-orange-700">نوع المتجر: {storeTypeLabel}</Badge>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-[20px] border border-[var(--line)] bg-white">
          {storeLogoUrl && showStoreLogo ? (
            <img
              src={storeLogoUrl}
              alt="Store logo"
              className="h-full w-full object-contain p-2"
              loading="eager"
              onError={() => setShowStoreLogo(false)}
            />
          ) : (
            <img src={SYSTEM_LOGO_DARK_URL} alt={`شعار ${SYSTEM_BRAND_NAME}`} className="h-9 w-auto object-contain px-1" />
          )}
        </div>
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--muted)] px-4 py-3 text-xs text-[var(--text-muted)]">{clock}</div>
        <div className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-right">
          <div className="font-bold">{userName}</div>
          <div className="text-xs text-[var(--text-muted)]">{roleLabel}</div>
        </div>
      </div>
    </header>
  )
}
