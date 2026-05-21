import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { apiGet, apiRequest } from '@/lib/api-client'
import { publishNotice } from '@/lib/notice-center'
import type { Supplier } from '@/types/api'

type SupplierFormState = {
  id?: number
  name: string
  phone: string
  contact_name: string
  address: string
  notes: string
  is_active: boolean
}

const emptyForm: SupplierFormState = {
  name: '',
  phone: '',
  contact_name: '',
  address: '',
  notes: '',
  is_active: true,
}

async function fetchSuppliers() {
  return apiGet<Supplier[]>('/suppliers')
}

export function SuppliersPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [formState, setFormState] = useState<SupplierFormState>(emptyForm)

  const suppliersQuery = useQuery({ queryKey: ['suppliers'], queryFn: fetchSuppliers })

  const saveMutation = useMutation({
    mutationFn: async (payload: SupplierFormState) => {
      const body = {
        name: payload.name.trim(),
        phone: payload.phone.trim() || null,
        contact_name: payload.contact_name.trim() || null,
        address: payload.address.trim() || null,
        notes: payload.notes.trim() || null,
        is_active: payload.is_active,
      }

      if (payload.id) {
        return apiRequest<Supplier>(`/suppliers/${payload.id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        })
      }

      return apiRequest<Supplier>('/suppliers', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    onSuccess: () => {
      setDialogOpen(false)
      setFormState(emptyForm)
      publishNotice('تم حفظ المورد بنجاح.', 'success')
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
    },
    onError: (mutationError: Error) => {
      publishNotice(mutationError.message, 'error')
    },
  })

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (suppliersQuery.data ?? []).filter((supplier) => {
      if (!q) return true
      return [supplier.name, supplier.phone, supplier.contact_name, supplier.address]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    })
  }, [search, suppliersQuery.data])

  const stats = useMemo(() => {
    const all = suppliersQuery.data ?? []
    return {
      total: all.length,
      active: all.filter((item) => item.is_active).length,
      inactive: all.filter((item) => !item.is_active).length,
    }
  }, [suppliersQuery.data])

  const openCreateDialog = () => {
    setFormState(emptyForm)
    setDialogOpen(true)
  }

  const openEditDialog = (supplier: Supplier) => {
    setFormState({
      id: supplier.id,
      name: supplier.name,
      phone: supplier.phone || '',
      contact_name: supplier.contact_name || '',
      address: supplier.address || '',
      notes: supplier.notes || '',
      is_active: supplier.is_active,
    })
    setDialogOpen(true)
  }

  const saveSupplier = async () => {
    await saveMutation.mutateAsync(formState)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black">الموردون</h2>
          <p className="mt-2 text-sm text-[var(--text-muted)]">إدارة الموردين وربطهم بفواتير الشراء دون تغيير منطق النظام الحالي.</p>
        </div>
        <Button type="button" onClick={openCreateDialog}>
          + إضافة مورد
        </Button>
      </div>

      <div className="grid grid-cols-[minmax(0,240px)_repeat(3,minmax(0,1fr))] gap-3">
        <Input placeholder="بحث بالمورد أو الهاتف..." value={search} onChange={(event) => setSearch(event.target.value)} />
        <StatCard title="إجمالي الموردين" value={String(stats.total)} />
        <StatCard title="نشطون" value={String(stats.active)} />
        <StatCard title="موقوفون" value={String(stats.inactive)} />
      </div>

      <Card className="min-h-0 flex-1 overflow-hidden p-0">
        <div className="h-full overflow-auto">
          <table className="w-full text-right">
            <thead className="sticky top-0 bg-[var(--muted)] text-sm">
              <tr className="border-b border-[var(--line)]">
                <th className="px-4 py-3">المورد</th>
                <th className="px-4 py-3">الهاتف</th>
                <th className="px-4 py-3">جهة الاتصال</th>
                <th className="px-4 py-3">العنوان</th>
                <th className="px-4 py-3">الحالة</th>
                <th className="px-4 py-3">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {suppliersQuery.isLoading ? (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={6}>
                    جارٍ تحميل الموردين...
                  </td>
                </tr>
              ) : rows.length ? (
                rows.map((supplier) => (
                  <tr key={supplier.id} className="border-b border-[var(--line)] text-sm">
                    <td className="px-4 py-3 font-bold">{supplier.name}</td>
                    <td className="px-4 py-3">{supplier.phone || '—'}</td>
                    <td className="px-4 py-3">{supplier.contact_name || '—'}</td>
                    <td className="px-4 py-3">{supplier.address || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={supplier.is_active ? 'rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700' : 'rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600'}>
                        {supplier.is_active ? 'نشط' : 'موقوف'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Button type="button" variant="secondary" className="h-9 rounded-xl px-3" onClick={() => openEditDialog(supplier)}>
                        تعديل
                      </Button>
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

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} className="max-w-2xl">
        <div className="space-y-4">
          <div>
            <div className="text-3xl font-black">{formState.id ? 'تعديل المورد' : 'إضافة مورد'}</div>
            <div className="mt-1 text-sm text-[var(--text-muted)]">نفس بيانات المورد الحالية ولكن داخل بنية React حديثة وقابلة للصيانة.</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="اسم المورد" value={formState.name} onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))} />
            <Input placeholder="الهاتف" value={formState.phone} onChange={(event) => setFormState((current) => ({ ...current, phone: event.target.value }))} />
            <Input placeholder="اسم جهة الاتصال" value={formState.contact_name} onChange={(event) => setFormState((current) => ({ ...current, contact_name: event.target.value }))} />
            <Input placeholder="العنوان" value={formState.address} onChange={(event) => setFormState((current) => ({ ...current, address: event.target.value }))} />
          </div>
          <textarea
            className="min-h-28 w-full rounded-[24px] border border-[var(--line)] bg-white px-4 py-3 outline-none"
            placeholder="ملاحظات"
            value={formState.notes}
            onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))}
          />
          <label className="flex items-center gap-2 rounded-2xl border border-[var(--line)] px-4 py-3">
            <input type="checkbox" checked={formState.is_active} onChange={(event) => setFormState((current) => ({ ...current, is_active: event.target.checked }))} />
            المورد نشط
          </label>
          <div className="flex gap-3">
            <Button type="button" className="flex-1" onClick={saveSupplier} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ المورد'}
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
