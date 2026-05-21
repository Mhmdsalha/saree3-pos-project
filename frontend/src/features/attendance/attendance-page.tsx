import { useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiGet, apiRequest } from '@/lib/api-client'
import type { AttendanceDay, AttendanceMonthlyEmployee, AttendancePeriod, User } from '@/types/api'

async function fetchUsers() {
  return apiGet<User[]>('/users')
}

async function fetchAttendanceMonthly(year: string, month: string) {
  return apiGet<AttendanceMonthlyEmployee[]>(`/attendance/monthly?year=${year}&month=${month}`)
}

export function AttendancePage() {
  const now = useMemo(() => new Date(), [])
  const [month, setMonth] = useState(String(now.getMonth() + 1))
  const [year, setYear] = useState(String(now.getFullYear()))
  const [selectedEmployee, setSelectedEmployee] = useState('')
  const [expandedDays, setExpandedDays] = useState<Record<string, boolean>>({})

  const usersQuery = useQuery({ queryKey: ['users'], queryFn: fetchUsers })
  const monthlyQuery = useQuery({
    queryKey: ['attendance', 'monthly', year, month],
    queryFn: () => fetchAttendanceMonthly(year, month),
  })

  const telegramMutation = useMutation({
    mutationFn: async ({ scope, employeeId }: { scope: 'employee' | 'all'; employeeId?: number }) => {
      return apiRequest<{ ok: boolean; messages_sent?: number; employee_name?: string }>('/attendance/send-telegram', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          year: Number(year),
          month: Number(month),
          employee_id: employeeId,
        }),
      })
    },
  })

  const users = useMemo(
    () =>
      (usersQuery.data ?? [])
        .filter((user) => user.is_active !== false)
        .sort((a, b) => rolePriority(a.role) - rolePriority(b.role) || a.name.localeCompare(b.name, 'ar')),
    [usersQuery.data],
  )

  const employeeId = selectedEmployee || (users[0] ? String(users[0].id) : '')

  const monthly = useMemo(() => {
    return (monthlyQuery.data ?? []).find((item) => String(item.id) === employeeId) ?? null
  }, [employeeId, monthlyQuery.data])

  const activeUser = useMemo(() => {
    return users.find((item) => String(item.id) === employeeId) ?? null
  }, [employeeId, users])

  const daily = monthly?.daily ?? []
  const workdayHours = Number(monthly?.workday_hours_target || 8)
  const completeDays = daily.filter((day) => isQualifiedWorkday(day.hours, workdayHours))
  const monthlyOvertime = daily.reduce((sum, day) => sum + overtimeHours(day.hours, workdayHours), 0)
  const totalPeriods = daily.reduce((sum, day) => sum + Number(day.sessions_count || 0), 0)
  const totalHours = monthly?.total_monthly_hours || 0
  const lastWorkedDay = [...daily].reverse().find((day) => Number(day.hours || 0) > 0)

  const sendTelegram = async (scope: 'employee' | 'all') => {
    await telegramMutation.mutateAsync({
      scope,
      employeeId: scope === 'employee' && employeeId ? Number(employeeId) : undefined,
    })
  }

  return (
    <div className="space-y-4 pb-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-2">
            <div className="text-xs font-black uppercase tracking-[0.18em] text-[var(--brand)]">Attendance</div>
            <div className="text-3xl font-black">الحضور اليومي والشهري</div>
            <div className="text-sm text-[var(--text-muted)]">متابعة أيام العمل وساعات الاتصال والفترات اليومية ضمن سجل واضح ومنظم.</div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-12 min-w-[220px] rounded-2xl border border-[var(--line)] bg-white px-4"
              value={employeeId}
              onChange={(event) => {
                setSelectedEmployee(event.target.value)
                setExpandedDays({})
              }}
            >
              {users.map((user) => (
                <option key={user.id} value={String(user.id)}>
                  {user.name} - {roleLabel(user.role)}
                </option>
              ))}
            </select>

            <select
              className="h-12 min-w-[140px] rounded-2xl border border-[var(--line)] bg-white px-4"
              value={month}
              onChange={(event) => {
                setMonth(event.target.value)
                setExpandedDays({})
              }}
            >
              {monthNames.map((label, index) => (
                <option key={label} value={String(index + 1)}>
                  {label}
                </option>
              ))}
            </select>

            <Input
              className="w-[120px]"
              inputMode="numeric"
              value={year}
              onChange={(event) => {
                setYear(event.target.value)
                setExpandedDays({})
              }}
            />

            <Button type="button" variant="secondary" onClick={() => sendTelegram('employee')} disabled={!employeeId || telegramMutation.isPending}>
              إرسال PDF الموظف
            </Button>
            <Button type="button" onClick={() => sendTelegram('all')} disabled={telegramMutation.isPending}>
              إرسال PDF الكل
            </Button>
          </div>
        </div>
      </Card>

      {!activeUser ? (
        <EmptyAttendance message="لا يوجد موظفون متاحون في صفحة الحضور." />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(320px,1.2fr)_repeat(3,minmax(220px,1fr))]">
            <Card className="rounded-[24px] p-5 shadow-none">
              <div className="text-sm font-bold text-[var(--text-muted)]">ملخص الموظف</div>
              <div className="mt-3 text-3xl font-black">{activeUser.name}</div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-[var(--line)] bg-[var(--muted)] px-3 py-2 text-xs font-bold text-[var(--text-muted)]">
                  {roleLabel(monthly?.role || activeUser.role)}
                </span>
                <span className="rounded-full border border-[var(--line)] bg-[var(--muted)] px-3 py-2 text-xs font-bold text-[var(--text-muted)]">
                  {monthLabel(Number(year), Number(month))}
                </span>
                <span className="rounded-full border border-[var(--line)] bg-[var(--muted)] px-3 py-2 text-xs font-bold text-[var(--text-muted)]">
                  ساعات اليوم المعتمدة: {formatWorkdayHours(workdayHours)}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <DetailCard label="آخر يوم عمل" value={formatDate(lastWorkedDay?.date)} />
                <DetailCard label="عدد الفترات" value={String(totalPeriods)} />
                <DetailCard label="أول اتصال بآخر يوم" value={formatTime(lastWorkedDay?.first_connected)} />
                <DetailCard label="آخر انقطاع بآخر يوم" value={formatTime(lastWorkedDay?.last_disconnected)} />
              </div>
            </Card>

            <MetricCard
              title="إجمالي ساعات الشهر"
              value={formatHours(totalHours)}
              note="مجموع مدد الاتصال الفعلية خلال الشهر المحدد."
              accent
            />
            <MetricCard
              title="أيام العمل المكتملة"
              value={String(completeDays.length)}
              note={`اليوم يُحتسب مكتملًا إذا وصل مجموع الاتصال إلى ${formatWorkdayHours(workdayHours)} أو أكثر.`}
            />
            <MetricCard
              title="الساعات الإضافية"
              value={formatHours(monthlyOvertime)}
              note={`أي وقت يزيد عن ${formatWorkdayHours(workdayHours)} في اليوم يظهر هنا كساعات إضافية.`}
              info
            />
          </div>

          <Card className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
              <div className="text-lg font-black">السجل الشهري</div>
              <div className="text-xs font-bold text-[var(--text-muted)]">
                {monthLabel(Number(year), Number(month))} • {completeDays.length} يوم مكتمل • {formatHours(monthlyOvertime)} إضافي
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-[1120px] w-full text-right text-sm">
                <thead className="bg-[var(--muted)]">
                  <tr className="border-b border-[var(--line)]">
                    <th className="px-4 py-3">اليوم</th>
                    <th className="px-4 py-3">التاريخ</th>
                    <th className="px-4 py-3">أول اتصال</th>
                    <th className="px-4 py-3">آخر انقطاع</th>
                    <th className="px-4 py-3">الفترات</th>
                    <th className="px-4 py-3">ساعات الاتصال</th>
                    <th className="px-4 py-3">الإضافي</th>
                    <th className="px-4 py-3">الحالة</th>
                    <th className="px-4 py-3">التفاصيل</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyQuery.isLoading ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={9}>
                        جارٍ تحميل بيانات الحضور...
                      </td>
                    </tr>
                  ) : daily.length ? (
                    daily.flatMap((day) => buildAttendanceRows(day, expandedDays[day.date], setExpandedDays, workdayHours))
                  ) : (
                    <tr>
                      <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={9}>
                        لا توجد بيانات حضور لهذا الشهر.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

function buildAttendanceRows(
  day: AttendanceDay,
  expanded: boolean | undefined,
  setExpandedDays: Dispatch<SetStateAction<Record<string, boolean>>>,
  workdayHours: number,
) {
  const key = day.date
  const extra = overtimeHours(day.hours, workdayHours)
  const periods = day.periods || []
  const flag = dayFlag(day, workdayHours)
  const rows: ReactNode[] = [
    <tr key={key} className="border-b border-[var(--line)] last:border-b-0">
      <td className="px-4 py-3">{weekday(day.date)}</td>
      <td className="px-4 py-3">{formatDate(day.date)}</td>
      <td className="px-4 py-3">{formatTime(day.first_connected)}</td>
      <td className="px-4 py-3">{formatTime(day.last_disconnected)}</td>
      <td className="px-4 py-3">{day.sessions_count}</td>
      <td className="px-4 py-3 font-black text-[var(--brand)]">{formatHours(day.hours)}</td>
      <td className="px-4 py-3">{extra > 0 ? <span className="font-black text-sky-700">{formatHours(extra)}</span> : '—'}</td>
      <td className="px-4 py-3">
        <span className={`rounded-full px-3 py-1 text-xs font-black ${flag.className}`}>{flag.text}</span>
      </td>
      <td className="px-4 py-3">
        <Button
          type="button"
          variant="secondary"
          className="h-9 rounded-full px-3 text-xs"
          onClick={() => setExpandedDays((current) => ({ ...current, [key]: !current[key] }))}
          disabled={!periods.length}
        >
          {periods.length ? (expanded ? 'إخفاء الفترات' : 'عرض الفترات') : 'لا توجد فترات'}
        </Button>
      </td>
    </tr>,
  ]

  if (periods.length && expanded) {
    rows.push(
      <tr key={`${key}-periods`}>
        <td className="bg-slate-50 px-0 py-0" colSpan={9}>
          <div className="border-t border-dashed border-slate-200 px-5 py-4">
            <div className="mb-3 text-sm font-black">فترات الاتصال الفعلية لهذا اليوم</div>
            <div className="grid gap-3">
              {periods.map((period, index) => (
                <div key={`${key}-${index}`} className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-3">
                  <div className="font-bold">
                    #{index + 1} {formatPeriod(period)}
                  </div>
                  <div className="font-black text-[var(--brand)]">{formatHours(period.hours || 0)}</div>
                </div>
              ))}
            </div>
          </div>
        </td>
      </tr>,
    )
  }

  return rows
}

function EmptyAttendance({ message }: { message: string }) {
  return (
    <Card className="flex min-h-[260px] items-center justify-center rounded-[28px] border-dashed bg-[var(--muted)]/40 p-8 text-center text-[var(--text-muted)] shadow-none">
      {message}
    </Card>
  )
}

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--muted)] px-4 py-3">
      <div className="text-xs text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 font-black">{value}</div>
    </div>
  )
}

function MetricCard({
  title,
  value,
  note,
  accent,
  info,
}: {
  title: string
  value: string
  note: string
  accent?: boolean
  info?: boolean
}) {
  const color = accent ? 'text-[var(--brand)]' : info ? 'text-sky-700' : 'text-[var(--text-strong)]'
  return (
    <Card className="rounded-[24px] p-5 shadow-none">
      <div className="text-sm font-bold text-[var(--text-muted)]">{title}</div>
      <div className={`mt-3 text-3xl font-black ${color}`}>{value}</div>
      <div className="mt-2 text-xs leading-6 text-[var(--text-muted)]">{note}</div>
    </Card>
  )
}

function rolePriority(role?: string | null) {
  return role === 'cashier' ? 1 : role === 'supervisor' ? 2 : role === 'admin' ? 3 : 99
}

function roleLabel(role?: string | null) {
  return role === 'admin' ? 'مدير' : role === 'supervisor' ? 'مشرف' : role === 'cashier' ? 'كاشير' : role || '—'
}

function dayFlag(day: AttendanceDay, workdayHours: number) {
  if (isQualifiedWorkday(day.hours, workdayHours)) {
    return { text: 'مكتمل', className: 'bg-emerald-50 text-emerald-700' }
  }
  if (Number(day.hours || 0) > 0) {
    return { text: 'جزئي', className: 'bg-amber-50 text-amber-700' }
  }
  return { text: 'لا يوجد اتصال', className: 'bg-slate-100 text-slate-600' }
}

function overtimeHours(value: number, workdayHours: number) {
  return Math.max(0, Number(value || 0) - Number(workdayHours || 0))
}

function isQualifiedWorkday(hours: number, workdayHours: number) {
  return Number(hours || 0) >= Number(workdayHours || 0)
}

function formatWorkdayHours(value: number) {
  return `${Number(value || 0).toFixed(2).replace(/\.00$/, '')} ساعة`
}

function formatHours(value: number) {
  return `${Number(value || 0).toFixed(2)} ساعة`
}

function formatPeriod(period: AttendancePeriod) {
  return `${formatTime(period.connected_at)} ← ${formatTime(period.disconnected_at)}`
}

function monthLabel(year: number, month: number) {
  return new Date(year, month - 1, 1).toLocaleDateString('ar-PS', { month: 'long', year: 'numeric', timeZone: 'Asia/Hebron' })
}

function weekday(value?: string | null) {
  const date = parseAppDate(value)
  if (!date) return '—'
  return date.toLocaleDateString('ar-PS', { weekday: 'short', timeZone: 'Asia/Hebron' })
}

function formatDate(value?: string | null) {
  const date = parseAppDate(value)
  if (!date) return '—'
  return date.toLocaleDateString('ar-PS', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Hebron' })
}

function formatTime(value?: string | null) {
  const date = parseAppDate(value)
  if (!date) return '—'
  return date.toLocaleTimeString('ar-PS', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Hebron' })
}

function parseAppDate(value?: string | null) {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day)
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']
