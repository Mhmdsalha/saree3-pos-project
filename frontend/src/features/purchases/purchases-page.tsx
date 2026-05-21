import { useDeferredValue, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { apiGet, apiRequest } from '@/lib/api-client'
import { publishNotice } from '@/lib/notice-center'
import { formatMoneyWithCurrency } from '@/lib/storefront'
import { storeSupportsWeightedProducts } from '@/lib/storefront'
import type { Category, Product, PurchaseCreatePayload, PurchaseDetail, PurchaseDraftItemPayload, PurchaseSummary, Supplier } from '@/types/api'

async function fetchSuppliers() {
  return apiGet<Supplier[]>('/suppliers')
}

async function fetchProducts() {
  return apiGet<Product[]>('/products')
}

async function fetchCategories() {
  return apiGet<Category[]>('/categories')
}

async function fetchPurchases() {
  return apiGet<PurchaseSummary[]>('/purchases')
}

async function fetchPurchaseDetails(id: number) {
  return apiGet<PurchaseDetail>(`/purchases/${id}`)
}

type DraftLineMode = 'existing' | 'new'

type DraftLineState = {
  mode: DraftLineMode
  product_search: string
  product_id: string
  product_name: string
  category_id: string
  unit: string
  min_stock: string
  is_weighted: boolean
  track_expiry: boolean
  track_batch: boolean
  quantity: string
  purchase_price: string
  selling_price: string
  expiry_date: string
  batch_number: string
  notes: string
}

const emptyDraftLine: DraftLineState = {
  mode: 'existing',
  product_search: '',
  product_id: '',
  product_name: '',
  category_id: '',
  unit: '',
  min_stock: '',
  is_weighted: false,
  track_expiry: false,
  track_batch: false,
  quantity: '',
  purchase_price: '',
  selling_price: '',
  expiry_date: '',
  batch_number: '',
  notes: '',
}

export function PurchasesPage() {
  const weightedEnabled = storeSupportsWeightedProducts()
  const queryClient = useQueryClient()
  const [supplierId, setSupplierId] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 16))
  const [discountAmount, setDiscountAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [draftLine, setDraftLine] = useState<DraftLineState>(emptyDraftLine)
  const [draftItems, setDraftItems] = useState<PurchaseDraftItemPayload[]>([])
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [selectedPurchaseId, setSelectedPurchaseId] = useState<number | null>(null)
  const deferredSearch = useDeferredValue(draftLine.product_search)

  const suppliersQuery = useQuery({ queryKey: ['suppliers'], queryFn: fetchSuppliers })
  const productsQuery = useQuery({ queryKey: ['products'], queryFn: fetchProducts })
  const categoriesQuery = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const purchasesQuery = useQuery({ queryKey: ['purchases'], queryFn: fetchPurchases })
  const purchaseDetailsQuery = useQuery({
    queryKey: ['purchases', selectedPurchaseId],
    queryFn: () => fetchPurchaseDetails(selectedPurchaseId as number),
    enabled: detailsOpen && selectedPurchaseId !== null,
  })

  const productMap = useMemo(() => new Map((productsQuery.data ?? []).map((product) => [product.id, product])), [productsQuery.data])
  const supplierMap = useMemo(() => new Map((suppliersQuery.data ?? []).map((supplier) => [supplier.id, supplier])), [suppliersQuery.data])
  const filteredProducts = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase()
    const rows = productsQuery.data ?? []
    if (!query) return rows.slice(0, 8)
    return rows
      .filter((product) => {
        return (
          product.name.toLowerCase().includes(query) ||
          String(product.barcode ?? '').includes(query) ||
          String(product.unit ?? '').toLowerCase().includes(query)
        )
      })
      .slice(0, 8)
  }, [deferredSearch, productsQuery.data])

  const savePurchaseMutation = useMutation({
    mutationFn: async ({ confirmAfterSave }: { confirmAfterSave: boolean }) => {
      const payload: PurchaseCreatePayload = {
        supplier_id: Number(supplierId),
        invoice_number: invoiceNumber.trim(),
        purchase_date: new Date(purchaseDate).toISOString(),
        discount_amount: Number(discountAmount || 0),
        notes: notes.trim() || null,
        items: draftItems,
      }

      const saved = await apiRequest<PurchaseDetail>('/purchases', {
        method: 'POST',
        body: JSON.stringify(payload),
      })

      if (confirmAfterSave) {
        return apiRequest<PurchaseDetail>(`/purchases/${saved.id}/confirm`, {
          method: 'POST',
        })
      }

      return saved
    },
    onSuccess: () => {
      resetDraft()
      publishNotice('تم حفظ فاتورة الشراء بنجاح.', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchases'] })
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
    onError: (mutationError: Error) => {
      publishNotice(mutationError.message, 'error')
    },
  })

  const draftActionMutation = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: 'confirm' | 'cancel' }) => {
      return apiRequest<PurchaseDetail | { ok: true }>(`/purchases/${id}/${action}`, {
        method: 'POST',
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['purchases'] })
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
      queryClient.invalidateQueries({ queryKey: ['products'] })
      if (selectedPurchaseId) {
        queryClient.invalidateQueries({ queryKey: ['purchases', selectedPurchaseId] })
      }
    },
    onError: (mutationError: Error) => {
      publishNotice(mutationError.message, 'error')
    },
  })

  const totals = useMemo(() => {
    const subtotal = draftItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.purchase_price || 0), 0)
    const discount = Number(discountAmount || 0)
    return {
      itemsCount: draftItems.length,
      subtotal,
      total: Math.max(0, subtotal - discount),
    }
  }, [draftItems, discountAmount])

  const selectExistingProduct = (product: Product) => {
    setDraftLine((current) => ({
      ...current,
      mode: 'existing',
      product_search: product.name,
      product_id: String(product.id),
      product_name: product.name,
      category_id: product.category_id ? String(product.category_id) : '',
      unit: product.unit || '',
      min_stock: product.min_stock != null ? String(product.min_stock) : '',
      is_weighted: weightedEnabled && Boolean(product.is_weighted),
      track_expiry: Boolean(product.track_expiry),
      track_batch: Boolean(product.track_batch),
      selling_price: product.price != null ? String(product.price) : current.selling_price,
    }))
  }

  const addDraftItem = () => {
    const quantity = Number(draftLine.quantity)
    const purchasePrice = Number(draftLine.purchase_price)
    if (quantity <= 0 || Number.isNaN(quantity)) {
      publishNotice('أدخل كمية صحيحة قبل إضافة الصنف.', 'error')
      return
    }
    if (purchasePrice < 0 || Number.isNaN(purchasePrice)) {
      publishNotice('سعر الشراء غير صالح.', 'error')
      return
    }

    const sellingPrice =
      draftLine.selling_price === ''
        ? null
        : Number.isNaN(Number(draftLine.selling_price))
          ? null
          : Number(draftLine.selling_price)

    if (draftLine.mode === 'existing') {
      const productId = Number(draftLine.product_id)
      if (!productId) {
        publishNotice('اختر صنفًا موجودًا من المخزون أولًا.', 'error')
        return
      }
      setDraftItems((current) => [
        ...current,
        {
          product_id: productId,
          quantity,
          purchase_price: purchasePrice,
          selling_price: sellingPrice,
          expiry_date: draftLine.expiry_date ? new Date(`${draftLine.expiry_date}T00:00:00`).toISOString() : null,
          batch_number: draftLine.batch_number.trim() || null,
          notes: draftLine.notes.trim() || null,
        },
      ])
      setDraftLine(emptyDraftLine)
      return
    }

    const productName = draftLine.product_name.trim()
    const stockUnit = draftLine.unit.trim()
    if (!productName) {
      publishNotice('اكتب اسم الصنف الجديد أولًا.', 'error')
      return
    }
    if (!stockUnit) {
      publishNotice('وحدة المخزون مطلوبة للصنف الجديد.', 'error')
      return
    }
    const minStock = draftLine.min_stock.trim() === '' ? 0 : Number(draftLine.min_stock)
    if (minStock < 0 || Number.isNaN(minStock)) {
      publishNotice('الحد الأدنى غير صالح.', 'error')
      return
    }

    setDraftItems((current) => [
      ...current,
      {
        product_id: null,
        product_name: productName,
        category_id: draftLine.category_id ? Number(draftLine.category_id) : null,
        unit: stockUnit,
        min_stock: minStock,
        is_weighted: weightedEnabled && draftLine.is_weighted,
        track_expiry: draftLine.track_expiry,
        track_batch: draftLine.track_batch,
        quantity,
        purchase_price: purchasePrice,
        selling_price: sellingPrice,
        expiry_date: draftLine.expiry_date ? new Date(`${draftLine.expiry_date}T00:00:00`).toISOString() : null,
        batch_number: draftLine.batch_number.trim() || null,
        notes: draftLine.notes.trim() || null,
      },
    ])
    setDraftLine(emptyDraftLine)
  }

  const persistPurchase = async (confirmAfterSave: boolean) => {
    if (!supplierId || !invoiceNumber.trim() || !purchaseDate || !draftItems.length) {
      publishNotice('أكمل بيانات فاتورة الشراء قبل الحفظ.', 'error')
      return
    }

    await savePurchaseMutation.mutateAsync({ confirmAfterSave })
  }

  const resetDraft = () => {
    setSupplierId('')
    setInvoiceNumber('')
    setPurchaseDate(new Date().toISOString().slice(0, 16))
    setDiscountAmount('')
    setNotes('')
    setDraftLine(emptyDraftLine)
    setDraftItems([])
  }

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <div className="h-full overflow-y-scroll overflow-x-hidden pb-4 pr-1">
        <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-lg font-black">إدخال المخزون عبر المشتريات</div>
          <div className="text-sm text-[var(--text-muted)]">الصنف الجديد يدخل من الشراء أولًا، ثم يتم تجهيزه للبيع وربطه بالباركود من صفحة المنتجات.</div>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={resetDraft}>
            مسودة جديدة
          </Button>
          <Button type="button" variant="secondary" onClick={() => persistPurchase(false)} disabled={savePurchaseMutation.isPending}>
            حفظ كمسودة
          </Button>
          <Button type="button" onClick={() => persistPurchase(true)} disabled={savePurchaseMutation.isPending}>
            تأكيد الشراء
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-4">
        <Card className="space-y-4 p-4">
          <select className="h-12 rounded-2xl border border-[var(--line)] bg-white px-4" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
            <option value="">اختر المورد</option>
            {(suppliersQuery.data ?? []).map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
          <Input placeholder="رقم فاتورة الشراء" value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} />
          <Input type="datetime-local" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} />
          <Input type="number" min="0" step="0.01" placeholder="الخصم" value={discountAmount} onChange={(event) => setDiscountAmount(event.target.value)} />
          <textarea
            className="min-h-28 w-full rounded-[24px] border border-[var(--line)] bg-white px-4 py-3 outline-none"
            placeholder="ملاحظات الفاتورة"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
          <div className="grid grid-cols-1 gap-3">
            <StatCard title="أصناف المسودة" value={String(totals.itemsCount)} />
            <StatCard title="الإجمالي قبل الخصم" value={formatMoneyWithCurrency(totals.subtotal)} />
            <StatCard title="الإجمالي النهائي" value={formatMoneyWithCurrency(totals.total)} />
          </div>
        </Card>

        <div className="grid gap-4">
          <Card className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-3">
              <Button type="button" variant={draftLine.mode === 'existing' ? 'default' : 'secondary'} onClick={() => setDraftLine((current) => ({ ...current, mode: 'existing' }))}>
                اختيار صنف موجود
              </Button>
              <Button type="button" variant={draftLine.mode === 'new' ? 'default' : 'secondary'} onClick={() => setDraftLine((current) => ({ ...current, mode: 'new', product_id: '' }))}>
                إضافة صنف جديد مع الشراء
              </Button>
            </div>

            {draftLine.mode === 'existing' ? (
              <div className="space-y-3">
                <Input
                  placeholder="ابحث عن صنف موجود في المخزون"
                  value={draftLine.product_search}
                  onChange={(event) => setDraftLine((current) => ({ ...current, product_search: event.target.value, product_id: '' }))}
                />
            <div className="max-h-48 overflow-auto rounded-[24px] border border-[var(--line)] bg-[var(--muted)] p-2">
                  <div className="grid gap-2">
                    {filteredProducts.map((product) => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => selectExistingProduct(product)}
                        className={`rounded-[20px] border px-4 py-3 text-right ${
                          Number(draftLine.product_id) === product.id ? 'border-[var(--brand)] bg-orange-50' : 'border-[var(--line)] bg-white'
                        }`}
                      >
                        <div className="font-black">{product.name}</div>
                        <div className="mt-1 text-xs text-[var(--text-muted)]">
                          {product.unit || 'بدون وحدة'} • مخزون {formatQuantity(product.stock)} • {product.is_sellable ? 'جاهز للبيع' : 'بانتظار التجهيز'}
                        </div>
                      </button>
                    ))}
                    {!filteredProducts.length ? (
                      <div className="rounded-[20px] bg-white px-4 py-6 text-center text-sm text-[var(--text-muted)]">لا توجد أصناف مطابقة للبحث.</div>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Input placeholder="اسم الصنف الجديد" value={draftLine.product_name} onChange={(event) => setDraftLine((current) => ({ ...current, product_name: event.target.value }))} />
                <Input placeholder="وحدة المخزون" value={draftLine.unit} onChange={(event) => setDraftLine((current) => ({ ...current, unit: event.target.value }))} />
                <select className="h-12 rounded-2xl border border-[var(--line)] bg-white px-4" value={draftLine.category_id} onChange={(event) => setDraftLine((current) => ({ ...current, category_id: event.target.value }))}>
                  <option value="">بدون قسم</option>
                  {(categoriesQuery.data ?? []).map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <Input type="number" min="0" step="0.001" placeholder="الحد الأدنى" value={draftLine.min_stock} onChange={(event) => setDraftLine((current) => ({ ...current, min_stock: event.target.value }))} />
                {weightedEnabled ? (
                  <label className="flex items-center gap-2 rounded-2xl border border-[var(--line)] px-4 py-3">
                  <input type="checkbox" checked={draftLine.is_weighted} onChange={(event) => setDraftLine((current) => ({ ...current, is_weighted: event.target.checked }))} />
                  صنف موزون
                  </label>
                ) : null}
                <label className="flex items-center gap-2 rounded-2xl border border-[var(--line)] px-4 py-3">
                  <input type="checkbox" checked={draftLine.track_expiry} onChange={(event) => setDraftLine((current) => ({ ...current, track_expiry: event.target.checked }))} />
                  تتبع صلاحية
                </label>
                <label className="flex items-center gap-2 rounded-2xl border border-[var(--line)] px-4 py-3">
                  <input type="checkbox" checked={draftLine.track_batch} onChange={(event) => setDraftLine((current) => ({ ...current, track_batch: event.target.checked }))} />
                  تتبع دفعات
                </label>
              </div>
            )}

            <div className="grid grid-cols-[repeat(4,minmax(0,1fr))_180px] gap-3">
              <Input type="number" min="0.001" step="0.001" placeholder="الكمية" value={draftLine.quantity} onChange={(event) => setDraftLine((current) => ({ ...current, quantity: event.target.value }))} />
              <Input type="number" min="0" step="0.01" placeholder="سعر الشراء" value={draftLine.purchase_price} onChange={(event) => setDraftLine((current) => ({ ...current, purchase_price: event.target.value }))} />
              <Input type="number" min="0" step="0.01" placeholder="سعر البيع المرجعي" value={draftLine.selling_price} onChange={(event) => setDraftLine((current) => ({ ...current, selling_price: event.target.value }))} />
              <Input type="date" placeholder="الانتهاء" value={draftLine.expiry_date} onChange={(event) => setDraftLine((current) => ({ ...current, expiry_date: event.target.value }))} />
              <Button type="button" onClick={addDraftItem}>
                إضافة للمسودة
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="رقم الدفعة" value={draftLine.batch_number} onChange={(event) => setDraftLine((current) => ({ ...current, batch_number: event.target.value }))} />
              <Input placeholder="ملاحظات الصنف" value={draftLine.notes} onChange={(event) => setDraftLine((current) => ({ ...current, notes: event.target.value }))} />
            </div>
          </Card>

          <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-4">
            <Card className="overflow-hidden p-0">
              <TableHeader title="أصناف فاتورة الشراء" />
              <div className="max-h-[520px] overflow-auto">
                <table className="w-full text-right text-sm">
                  <thead className="sticky top-0 bg-[var(--muted)]">
                    <tr className="border-b border-[var(--line)]">
                      <th className="px-4 py-3">الصنف</th>
                      <th className="px-4 py-3">الوحدة</th>
                      <th className="px-4 py-3">الكمية</th>
                      <th className="px-4 py-3">الشراء</th>
                      <th className="px-4 py-3">البيع</th>
                      <th className="px-4 py-3">الحالة</th>
                      <th className="px-4 py-3">إجراء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draftItems.length ? (
                      draftItems.map((item, index) => {
                        const product = item.product_id ? productMap.get(item.product_id) : null
                        const name = product?.name || item.product_name || `#${item.product_id}`
                        const unit = product?.unit || item.unit || '—'
                        const status = product?.is_sellable ? 'جاهز للبيع' : 'مخزني فقط'
                        return (
                          <tr key={`${item.product_id ?? item.product_name}-${index}`} className="border-b border-[var(--line)]">
                            <td className="px-4 py-3 font-bold">{name}</td>
                            <td className="px-4 py-3">{unit}</td>
                            <td className="px-4 py-3">{formatQuantity(item.quantity)}</td>
                            <td className="px-4 py-3">{Number(item.purchase_price).toFixed(2)}</td>
                            <td className="px-4 py-3">{item.selling_price != null ? Number(item.selling_price).toFixed(2) : '—'}</td>
                            <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{status}</td>
                            <td className="px-4 py-3">
                              <Button
                                type="button"
                                variant="secondary"
                                className="h-9 rounded-xl px-3 text-red-600"
                                onClick={() => setDraftItems((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                              >
                                حذف
                              </Button>
                            </td>
                          </tr>
                        )
                      })
                    ) : (
                      <tr>
                        <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={7}>
                          لم تتم إضافة أصناف إلى المسودة بعد.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="overflow-hidden p-0">
              <TableHeader title="آخر فواتير الشراء" />
              <div className="max-h-[520px] overflow-auto">
                <table className="w-full text-right text-sm">
                  <thead className="sticky top-0 bg-[var(--muted)]">
                    <tr className="border-b border-[var(--line)]">
                      <th className="px-4 py-3">#</th>
                      <th className="px-4 py-3">المورد</th>
                      <th className="px-4 py-3">الحالة</th>
                      <th className="px-4 py-3">المجموع</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(purchasesQuery.data ?? []).map((purchase) => (
                      <tr
                        key={purchase.id}
                        className="cursor-pointer border-b border-[var(--line)]"
                        onClick={() => {
                          setSelectedPurchaseId(purchase.id)
                          setDetailsOpen(true)
                        }}
                      >
                        <td className="px-4 py-3">#{purchase.id}</td>
                        <td className="px-4 py-3">{supplierMap.get(purchase.supplier_id)?.name || '—'}</td>
                        <td className="px-4 py-3">
                          <StatusPill status={purchase.status} />
                        </td>
                        <td className="px-4 py-3">{Number(purchase.total_amount || 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </div>
      </div>

      <Dialog open={detailsOpen} onClose={() => setDetailsOpen(false)} className="max-w-5xl">
        {purchaseDetailsQuery.isLoading ? (
          <div className="py-12 text-center text-[var(--text-muted)]">جارٍ تحميل تفاصيل الفاتورة...</div>
        ) : purchaseDetailsQuery.data ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-3xl font-black">فاتورة شراء #{purchaseDetailsQuery.data.id}</div>
                <div className="mt-1 text-sm text-[var(--text-muted)]">
                  {purchaseDetailsQuery.data.supplier_name || '—'} • {formatDateTime(purchaseDetailsQuery.data.purchase_date)}
                </div>
              </div>
              {purchaseDetailsQuery.data.status === 'draft' ? (
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" onClick={() => draftActionMutation.mutate({ id: purchaseDetailsQuery.data!.id, action: 'cancel' })} disabled={draftActionMutation.isPending}>
                    إلغاء المسودة
                  </Button>
                  <Button type="button" onClick={() => draftActionMutation.mutate({ id: purchaseDetailsQuery.data!.id, action: 'confirm' })} disabled={draftActionMutation.isPending}>
                    تأكيد الفاتورة
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="grid grid-cols-[repeat(4,minmax(0,1fr))] gap-3">
              <StatCard title="الحالة" value={statusLabel(purchaseDetailsQuery.data.status)} />
              <StatCard title="المجموع الفرعي" value={formatMoneyWithCurrency(Number(purchaseDetailsQuery.data.subtotal || 0))} />
              <StatCard title="الخصم" value={formatMoneyWithCurrency(Number(purchaseDetailsQuery.data.discount_amount || 0))} />
              <StatCard title="الإجمالي" value={formatMoneyWithCurrency(Number(purchaseDetailsQuery.data.total_amount || 0))} />
            </div>

            <Card className="overflow-hidden p-0 shadow-none">
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full text-right text-sm">
                  <thead className="sticky top-0 bg-[var(--muted)]">
                    <tr className="border-b border-[var(--line)]">
                      <th className="px-4 py-3">الصنف</th>
                      <th className="px-4 py-3">الوحدة</th>
                      <th className="px-4 py-3">الكمية</th>
                      <th className="px-4 py-3">الشراء</th>
                      <th className="px-4 py-3">البيع</th>
                      <th className="px-4 py-3">الحالة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseDetailsQuery.data.items.map((item) => (
                      <tr key={item.id} className="border-b border-[var(--line)]">
                        <td className="px-4 py-3 font-bold">{item.product_name || `#${item.product_id}`}</td>
                        <td className="px-4 py-3">{item.unit || '—'}</td>
                        <td className="px-4 py-3">{formatQuantity(item.quantity)}</td>
                        <td className="px-4 py-3">{Number(item.purchase_price || 0).toFixed(2)}</td>
                        <td className="px-4 py-3">{item.selling_price != null ? Number(item.selling_price).toFixed(2) : '—'}</td>
                        <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{item.is_sellable ? 'جاهز للبيع' : 'بانتظار الربط للبيع'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        ) : (
          <div className="py-12 text-center text-[var(--text-muted)]">تعذر تحميل التفاصيل.</div>
        )}
      </Dialog>
        </div>
      </div>
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
      <div className="mt-3 text-xl font-black">{value}</div>
    </Card>
  )
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={
        status === 'confirmed'
          ? 'rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700'
          : status === 'draft'
            ? 'rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700'
            : 'rounded-full bg-red-50 px-3 py-1 text-xs font-bold text-red-700'
      }
    >
      {statusLabel(status)}
    </span>
  )
}

function statusLabel(status: string) {
  return status === 'confirmed' ? 'مؤكدة' : status === 'draft' ? 'مسودة' : 'ملغاة'
}

function formatDateTime(value?: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hebron' }).format(new Date(value))
}

function formatQuantity(value?: number | null) {
  const numeric = Number(value || 0)
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(3)
}
