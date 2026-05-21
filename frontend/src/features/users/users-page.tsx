import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { apiGet, apiRequest } from '@/lib/api-client'
import { publishNotice } from '@/lib/notice-center'
import type { User, UserCreatePayload, UserUpdatePayload, UserRole } from '@/types/api'

type UserFormState = {
  id?: number
  name: string
  username: string
  phone: string
  password: string
  role: UserRole
  cashier_number: string
  is_active: boolean
}

const emptyForm: UserFormState = {
  name: '',
  username: '',
  phone: '',
  password: '',
  role: 'cashier',
  cashier_number: '',
  is_active: true,
}

async function fetchUsers() {
  return apiGet<User[]>('/users')
}

export function UsersPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [formState, setFormState] = useState<UserFormState>(emptyForm)

  const usersQuery = useQuery({ queryKey: ['users'], queryFn: fetchUsers })

  const saveMutation = useMutation({
    mutationFn: async (payload: UserFormState) => {
      if (payload.id) {
        const body: UserUpdatePayload = {
          name: payload.name.trim(),
          phone: payload.phone.trim() || null,
          password: payload.password.trim() || undefined,
          role: payload.role,
          cashier_number: payload.cashier_number ? Number(payload.cashier_number) : null,
          is_active: payload.is_active,
        }
        return apiRequest<User>(`/users/${payload.id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        })
      }

      const body: UserCreatePayload = {
        name: payload.name.trim(),
        username: payload.username.trim(),
        phone: payload.phone.trim() || null,
        password: payload.password,
        role: payload.role,
        cashier_number: payload.cashier_number ? Number(payload.cashier_number) : null,
      }

      return apiRequest<User>('/users', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    onSuccess: () => {
      setDialogOpen(false)
      setFormState(emptyForm)
      publishNotice('تم حفظ المستخدم بنجاح.', 'success')
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (mutationError: Error) => {
      publishNotice(mutationError.message, 'error')
    },
  })

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      return apiRequest<User>(`/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !isActive }),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (usersQuery.data ?? []).filter((user) => {
      if (!q) return true
      return [user.name, user.username, user.phone, user.cashier_number]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    })
  }, [search, usersQuery.data])

  const stats = useMemo(() => {
    const all = usersQuery.data ?? []
    return {
      total: all.length,
      active: all.filter((item) => item.is_active).length,
      cashiers: all.filter((item) => item.role === 'cashier').length,
      admins: all.filter((item) => item.role !== 'cashier').length,
    }
  }, [usersQuery.data])

  const openCreateDialog = () => {
    setFormState(emptyForm)
    setDialogOpen(true)
  }

  const openEditDialog = (user: User) => {
    setFormState({
      id: user.id,
      name: user.name,
      username: user.username,
      phone: user.phone || '',
      password: '',
      role: user.role,
      cashier_number: user.cashier_number ? String(user.cashier_number) : '',
      is_active: Boolean(user.is_active),
    })
    setDialogOpen(true)
  }

  const saveUser = async () => {
    if (!formState.id && !formState.password.trim()) {
      publishNotice('كلمة السر مطلوبة عند إنشاء مستخدم جديد.', 'error')
      return
    }
    await saveMutation.mutateAsync(formState)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black">المستخدمون</h2>
          <p className="mt-2 text-sm text-[var(--text-muted)]">إدارة المستخدمين والصلاحيات بنفس الـ APIs الحالية دون تغيير منطق التفعيل أو الأدوار.</p>
        </div>
        <Button type="button" onClick={openCreateDialog}>
          + إضافة مستخدم
        </Button>
      </div>

      <div className="grid grid-cols-[minmax(0,240px)_repeat(4,minmax(0,1fr))] gap-3">
        <Input placeholder="بحث بالاسم أو اسم المستخدم..." value={search} onChange={(event) => setSearch(event.target.value)} />
        <StatCard title="إجمالي المستخدمين" value={String(stats.total)} />
        <StatCard title="نشطون" value={String(stats.active)} />
        <StatCard title="كاشير" value={String(stats.cashiers)} />
        <StatCard title="إدارة" value={String(stats.admins)} />
      </div>

      <Card className="min-h-0 flex-1 overflow-hidden p-0">
        <div className="h-full overflow-auto">
          <table className="w-full text-right">
            <thead className="sticky top-0 bg-[var(--muted)] text-sm">
              <tr className="border-b border-[var(--line)]">
                <th className="px-4 py-3">الاسم</th>
                <th className="px-4 py-3">المستخدم</th>
                <th className="px-4 py-3">الدور</th>
                <th className="px-4 py-3">رقم الكاشير</th>
                <th className="px-4 py-3">الحالة</th>
                <th className="px-4 py-3">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {usersQuery.isLoading ? (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={6}>
                    جارٍ تحميل المستخدمين...
                  </td>
                </tr>
              ) : rows.length ? (
                rows.map((user) => (
                  <tr key={user.id} className="border-b border-[var(--line)] text-sm">
                    <td className="px-4 py-3 font-bold">{user.name}</td>
                    <td className="px-4 py-3">{user.username}</td>
                    <td className="px-4 py-3">{roleLabel(user.role)}</td>
                    <td className="px-4 py-3">{user.cashier_number || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={user.is_active ? 'rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700' : 'rounded-full bg-red-50 px-3 py-1 text-xs font-bold text-red-700'}>
                        {user.is_active ? 'نشط' : 'موقف'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <Button type="button" variant="secondary" className="h-9 rounded-xl px-3" onClick={() => openEditDialog(user)}>
                          تعديل
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          className="h-9 rounded-xl px-3"
                          onClick={() => toggleMutation.mutate({ id: user.id, isActive: Boolean(user.is_active) })}
                          disabled={toggleMutation.isPending}
                        >
                          {user.is_active ? 'تعطيل' : 'تفعيل'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={6}>
                    لا توجد نتائج.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} className="max-w-3xl">
        <div className="space-y-4">
          <div>
            <div className="text-3xl font-black">{formState.id ? 'تعديل المستخدم' : 'إضافة مستخدم'}</div>
            <div className="mt-1 text-sm text-[var(--text-muted)]">نفس منطق إضافة وتحديث المستخدمين والتفعيل المستخدم حاليًا في النظام.</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="الاسم الكامل" value={formState.name} onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))} />
            <Input placeholder="اسم المستخدم" value={formState.username} disabled={Boolean(formState.id)} onChange={(event) => setFormState((current) => ({ ...current, username: event.target.value }))} />
            <Input placeholder="رقم الموبايل" value={formState.phone} onChange={(event) => setFormState((current) => ({ ...current, phone: event.target.value }))} />
            <Input placeholder={formState.id ? 'كلمة السر الجديدة (اختياري)' : 'كلمة السر'} type="password" value={formState.password} onChange={(event) => setFormState((current) => ({ ...current, password: event.target.value }))} />
            <Input placeholder="رقم الكاشير" type="number" value={formState.cashier_number} onChange={(event) => setFormState((current) => ({ ...current, cashier_number: event.target.value }))} />
            <select className="h-12 rounded-2xl border border-[var(--line)] bg-white px-4" value={formState.role} onChange={(event) => setFormState((current) => ({ ...current, role: event.target.value as UserRole }))}>
              <option value="cashier">كاشير</option>
              <option value="supervisor">مشرف</option>
              <option value="admin">مدير</option>
            </select>
          </div>
          {formState.id ? (
            <label className="flex items-center gap-2 rounded-2xl border border-[var(--line)] px-4 py-3">
              <input type="checkbox" checked={formState.is_active} onChange={(event) => setFormState((current) => ({ ...current, is_active: event.target.checked }))} />
              المستخدم نشط
            </label>
          ) : null}
          <div className="flex gap-3">
            <Button type="button" className="flex-1" onClick={saveUser} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ المستخدم'}
            </Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setDialogOpen(false)}>
              إلغاء
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card className="rounded-[24px] p-4 shadow-none">
      <div className="text-sm text-[var(--text-muted)]">{title}</div>
      <div className="mt-3 text-2xl font-black">{value}</div>
    </Card>
  )
}

function roleLabel(role: UserRole) {
  return role === 'admin' ? 'مدير' : role === 'supervisor' ? 'مشرف' : 'كاشير'
}
