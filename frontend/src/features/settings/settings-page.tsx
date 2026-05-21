import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiGet, apiRequest, resolveApiOrigin } from '@/lib/api-client'
import { getStoredUser } from '@/lib/auth'
import type { WorkdayHoursSetting } from '@/types/api'

const SHOP_NAME_KEY = 'pos_shop_name'
const MOBILE_SERVER_KEY = 'pos_mobile_server'

async function fetchServerIp() {
  return apiGet<{ ip: string }>('/server-ip')
}

async function fetchLocalMobileUrl() {
  return apiGet<{ url: string | null; mobile_url?: string | null; active?: boolean; mode?: string | null }>('/local-mobile-url')
}

async function fetchWorkdayHours() {
  return apiGet<WorkdayHoursSetting>('/system-settings/workday-hours')
}

export function SettingsPage() {
  const queryClient = useQueryClient()
  const currentSession = getStoredUser()
  const canEditWorkdayHours = currentSession?.user.role === 'admin'
  const [serverUrl, setServerUrl] = useState('')
  const [mobileServer, setMobileServer] = useState('')
  const [shopName, setShopName] = useState('سريع')
  const [workdayHours, setWorkdayHours] = useState('8')
  const [statusMessage, setStatusMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  const serverIpQuery = useQuery({ queryKey: ['settings', 'server-ip'], queryFn: fetchServerIp })
  const localMobileQuery = useQuery({ queryKey: ['settings', 'local-mobile-url'], queryFn: fetchLocalMobileUrl })
  const workdayHoursQuery = useQuery({ queryKey: ['system-settings', 'workday-hours'], queryFn: fetchWorkdayHours })

  useEffect(() => {
    setServerUrl(resolveApiOrigin(true))
    setMobileServer(window.localStorage.getItem(MOBILE_SERVER_KEY) || '')
    setShopName(window.localStorage.getItem(SHOP_NAME_KEY) || 'سريع')
  }, [])

  useEffect(() => {
    if (workdayHoursQuery.data) {
      setWorkdayHours(String(workdayHoursQuery.data.value))
    }
  }, [workdayHoursQuery.data])

  const previewMobileOrigin = useMemo(() => {
    if (localMobileQuery.data?.url) {
      const localOrigin = String(localMobileQuery.data.mobile_url || localMobileQuery.data.url).replace(/\/mobile-react\/?$/i, '').replace(/\/$/, '')
      if (!mobileServer.trim()) {
        return localOrigin
      }

      const clean = mobileServer.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
      const isIP = /^\d+\.\d+\.\d+\.\d+/.test(clean) || clean.startsWith('localhost')
      if (isIP) {
        return localOrigin
      }
      return `https://${clean}`
    }
    if (mobileServer.trim()) {
      const clean = mobileServer.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
      return `https://${clean}`
    }
    if (serverIpQuery.data?.ip && serverIpQuery.data.ip !== '127.0.0.1') {
      try {
        const origin = new URL(resolveApiOrigin(true))
        return `https://${serverIpQuery.data.ip}:${origin.port || '8000'}`
      } catch {
        return `https://${serverIpQuery.data.ip}:8000`
      }
    }
    return resolveApiOrigin(true)
  }, [mobileServer, serverIpQuery.data, localMobileQuery.data])

  const workdayMutation = useMutation({
    mutationFn: async (value: number) => {
      return apiRequest<WorkdayHoursSetting>('/system-settings/workday-hours', {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['system-settings', 'workday-hours'], data)
      void queryClient.invalidateQueries({ queryKey: ['attendance'] })
    },
  })

  const saveSettings = async () => {
    setStatusMessage(null)
    try {
      if (mobileServer.trim()) window.localStorage.setItem(MOBILE_SERVER_KEY, mobileServer.trim())
      else window.localStorage.removeItem(MOBILE_SERVER_KEY)
      window.localStorage.setItem(SHOP_NAME_KEY, shopName.trim() || 'FlowPOS')

      if (canEditWorkdayHours) {
        await workdayMutation.mutateAsync(Number(workdayHours))
      }

      setStatusMessage({ text: 'تم حفظ الإعدادات بنجاح', tone: 'success' })
      window.setTimeout(() => setStatusMessage(null), 2000)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذر حفظ الإعدادات الآن'
      setStatusMessage({ text: message, tone: 'error' })
    }
  }

  return (
    <div className="flex min-h-full flex-col gap-4 overflow-y-auto overflow-x-hidden pr-1">
      <div>
        <h2 className="text-3xl font-black">الإعدادات</h2>
        <p className="mt-2 text-sm text-[var(--text-muted)]">هنا نضبط رابط الموبايل واسم المتجر وإعدادات الحضور العامة التي تؤثر على التقارير وساعات العمل اليومية.</p>
      </div>

      <div className="grid min-h-0 grid-cols-[minmax(0,560px)_minmax(280px,1fr)] gap-4">
        <Card className="p-5">
          <div className="space-y-4">
            <Field label="عنوان السيرفر (تلقائي)">
              <Input value={serverUrl} readOnly />
            </Field>
            <Field label="رابط الموبايل المخصص (IP محلي — اتركه فارغًا للتلقائي)">
              <Input
                value={mobileServer}
                onChange={(event) => setMobileServer(event.target.value)}
                placeholder="192.168.1.7:8000"
              />
              <div className="mt-2 text-xs leading-6 text-[var(--text-muted)]">يمكنك تركه فارغًا ليعتمد النظام الرابط الآمن تلقائيًا عند توفره.</div>
            </Field>
            <Field label="اسم المتجر">
              <Input value={shopName} onChange={(event) => setShopName(event.target.value)} placeholder="FlowPOS" />
            </Field>
            <Field label="عدد ساعات العمل اليومية المعتمدة للموظف">
              <Input
                inputMode="decimal"
                value={workdayHours}
                onChange={(event) => setWorkdayHours(event.target.value)}
                placeholder="8"
                disabled={!canEditWorkdayHours}
              />
              <div className="mt-2 text-xs leading-6 text-[var(--text-muted)]">
                هذا الرقم يحدد متى يعتبر اليوم مكتملًا في الحضور، ومتى يبدأ احتساب الساعات الإضافية.
                {workdayHoursQuery.data?.label ? ` القيمة الحالية: ${workdayHoursQuery.data.label}` : ''}
                {!canEditWorkdayHours ? ' تعديل هذا الإعداد متاح للمدير فقط.' : ''}
              </div>
            </Field>
            <div className="flex gap-3">
              <Button type="button" onClick={() => void saveSettings()} disabled={workdayMutation.isPending}>
                {workdayMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ الإعدادات'}
              </Button>
              {statusMessage ? (
                <div className={`flex items-center text-sm font-bold ${statusMessage.tone === 'success' ? 'text-emerald-700' : 'text-red-700'}`}>
                  {statusMessage.text}
                </div>
              ) : null}
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="space-y-4">
            <div>
              <div className="text-lg font-black">معلومات الربط</div>
              <div className="mt-1 text-sm text-[var(--text-muted)]">هذه البيانات تساعد في ربط الموبايل وإظهار الرابط المتوقع الذي سيستخدمه QR.</div>
            </div>
            <InfoRow label="الرابط المخصص الحالي" value={mobileServer.trim() || 'غير محدد'} />
            <InfoRow label="رابط HTTPS المحلي" value={localMobileQuery.data?.url || 'غير متوفر'} />
            <InfoRow label="IP الشبكة المحلية" value={serverIpQuery.data?.ip || 'غير متوفر'} />
            <InfoRow label="الرابط المتوقع للجوال" value={`${previewMobileOrigin}/mobile-react/`} mono />
            <InfoRow label="اسم المتجر للطباعة" value={shopName.trim() || 'FlowPOS'} />
            <InfoRow
              label="ساعات العمل اليومية الحالية"
              value={workdayHoursQuery.data?.label || (workdayHoursQuery.isLoading ? 'جارٍ التحميل...' : 'غير متوفر')}
            />
          </div>
        </Card>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-sm font-bold text-[var(--text-muted)]">{label}</div>
      {children}
    </div>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-[22px] border border-[var(--line)] bg-[var(--muted)] px-4 py-4">
      <div className="text-sm font-bold text-[var(--text-muted)]">{label}</div>
      <div className={`mt-2 break-all text-sm font-black text-[var(--text-strong)] ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  )
}
