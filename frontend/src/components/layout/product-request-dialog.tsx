import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { apiGet, apiRequest } from '@/lib/api-client'
import { publishNotice } from '@/lib/notice-center'
import { storeSupportsWeightedProducts } from '@/lib/storefront'
import type { Category, Product, ProductPrepareForSalePayload, ProductSetupCandidate } from '@/types/api'

type ProductRequestDialogProps = {
  open: boolean
  barcode: string
  onClose: () => void
}

type ProductSetupState = {
  productId?: number
  search: string
  name: string
  category_id: string
  buy_price: string
  price: string
  min_stock: string
  unit: string
  is_weighted: boolean
  track_expiry: boolean
  track_batch: boolean
  expiry_date: string
  extra_barcodes: string
}

const emptyState: ProductSetupState = {
  search: '',
  name: '',
  category_id: '',
  buy_price: '',
  price: '',
  min_stock: '5',
  unit: '',
  is_weighted: false,
  track_expiry: false,
  track_batch: false,
  expiry_date: '',
  extra_barcodes: '',
}

async function fetchCategories() {
  return apiGet<Category[]>('/categories')
}

async function fetchProducts() {
  return apiGet<Product[]>('/products')
}

async function searchSetupCandidates(query: string) {
  return apiGet<ProductSetupCandidate[]>(`/products/setup-candidates?q=${encodeURIComponent(query)}&limit=10`)
}

function isValidEAN13(barcode: string) {
  const value = String(barcode || '').trim()
  if (!/^\d{13}$/.test(value)) return false
  const digits = value.split('').map(Number)
  const checkDigit = digits.pop()
  if (checkDigit == null) return false
  const sum = digits.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0)
  return (10 - (sum % 10)) % 10 === checkDigit
}

export function ProductRequestDialog({ open, barcode, onClose }: ProductRequestDialogProps) {
  const weightedEnabled = storeSupportsWeightedProducts()
  const queryClient = useQueryClient()
  const [state, setState] = useState<ProductSetupState>(emptyState)
  const deferredSearch = useDeferredValue(state.search)

  const categoriesQuery = useQuery({ queryKey: ['categories'], queryFn: fetchCategories, enabled: open })
  const productsQuery = useQuery({ queryKey: ['products'], queryFn: fetchProducts, enabled: open })
  const candidatesQuery = useQuery({
    queryKey: ['product-setup-candidates', deferredSearch],
    queryFn: () => searchSetupCandidates(deferredSearch),
    enabled: open && deferredSearch.trim().length > 0,
  })

  const productMap = useMemo(() => new Map((productsQuery.data ?? []).map((product) => [product.id, product])), [productsQuery.data])

  useEffect(() => {
    if (!open) return
    setState(emptyState)
  }, [open])

  const fillFromProduct = (product: Product) => {
    setState({
      productId: product.id,
      search: product.name,
      name: product.name,
      category_id: product.category_id ? String(product.category_id) : '',
      buy_price: String(product.buy_price ?? 0),
      price: String(product.price ?? ''),
      min_stock: String(product.min_stock ?? 5),
      unit: product.unit || '',
      is_weighted: weightedEnabled && Boolean(product.is_weighted),
      track_expiry: Boolean(product.track_expiry),
      track_batch: Boolean(product.track_batch),
      expiry_date: product.expiry_date ? String(product.expiry_date).slice(0, 16) : '',
      extra_barcodes: (product.extra_barcodes || []).map((item) => item.barcode).join(', '),
    })
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!state.productId) {
        throw new Error('اختر صنفًا موجودًا من المخزون أولًا.')
      }
      if (!state.name.trim()) {
        throw new Error('اسم الصنف مطلوب.')
      }
      if (!state.unit.trim()) {
        throw new Error('وحدة المخزون مطلوبة.')
      }
      if (state.is_weighted) {
        throw new Error('هذا المسار مخصص للأصناف ذات الباركود فقط. الصنف الموزون يجهز من صفحة المنتجات.')
      }
      const cleanBarcode = String(barcode || '').trim()
      if (!cleanBarcode) {
        throw new Error('الباركود غير متوفر.')
      }
      if (!isValidEAN13(cleanBarcode)) {
        throw new Error('الباركود يجب أن يكون EAN-13 صالحًا.')
      }
      if (Number(state.price || 0) <= 0) {
        throw new Error('سعر البيع مطلوب.')
      }

      const payload: ProductPrepareForSalePayload = {
        barcode: cleanBarcode,
        name: state.name.trim(),
        category_id: state.category_id ? Number(state.category_id) : null,
        buy_price: Number(state.buy_price || 0),
        price: Number(state.price || 0),
        min_stock: Number(state.min_stock || 5),
        unit: state.unit.trim(),
        is_weighted: false,
        track_expiry: state.track_expiry,
        track_batch: state.track_batch,
        expiry_date: state.expiry_date ? new Date(state.expiry_date).toISOString() : null,
        extra_barcodes: state.extra_barcodes
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      }

      return apiRequest<Product>(`/products/${state.productId}/prepare-for-sale`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['products'] })
      await queryClient.invalidateQueries({ queryKey: ['inventory'] })
      publishNotice('تم ربط الباركود وتجهيز الصنف للبيع بنجاح.', 'success')
      onClose()
    },
    onError: (mutationError) => {
      publishNotice(mutationError instanceof Error ? mutationError.message : 'تعذر ربط الباركود بالصنف.', 'error')
    },
  })

  return (
    <Dialog open={open} onClose={onClose} className="max-w-4xl">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-2xl font-black">تجهيز صنف من طلب الموبايل</div>
            <div className="mt-2 text-sm text-[var(--text-muted)]">ابحث عن صنف موجود دخل من المشتريات أو المخزون، ثم اربط له هذا الباركود ليصبح جاهزًا للبيع.</div>
          </div>
          <div className="rounded-2xl border border-[var(--line)] bg-[var(--muted)] px-4 py-3 font-mono text-sm font-black">{barcode || '—'}</div>
        </div>

        <Input placeholder="ابحث عن اسم الصنف في المخزون" value={state.search} onChange={(event) => setState((current) => ({ ...current, search: event.target.value }))} />

        <div className="max-h-[260px] overflow-auto rounded-[24px] border border-[var(--line)] bg-[var(--muted)] p-2">
          <div className="grid gap-2">
            {(candidatesQuery.data ?? []).map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => {
                  const product = productMap.get(candidate.id)
                  if (product) fillFromProduct(product)
                }}
                className={`rounded-[20px] border px-4 py-3 text-right ${
                  state.productId === candidate.id ? 'border-[var(--brand)] bg-orange-50' : 'border-[var(--line)] bg-white'
                }`}
              >
                <div className="font-black">{candidate.name}</div>
                <div className="mt-1 text-xs text-[var(--text-muted)]">
                  {candidate.unit || 'بدون وحدة'} • مخزون {formatQuantity(candidate.stock)} • {candidate.is_sellable ? 'جاهز للبيع' : 'بانتظار الربط'}
                </div>
              </button>
            ))}
            {!candidatesQuery.isFetching && state.search.trim() && !(candidatesQuery.data ?? []).length ? (
              <div className="rounded-[20px] bg-white px-4 py-6 text-center text-sm text-[var(--text-muted)]">لا توجد أصناف مطابقة لهذا البحث.</div>
            ) : null}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Input placeholder="اسم الصنف" value={state.name} onChange={(event) => setState((current) => ({ ...current, name: event.target.value }))} />
          <Input placeholder="وحدة المخزون" value={state.unit} onChange={(event) => setState((current) => ({ ...current, unit: event.target.value }))} />
          <select className="h-12 rounded-2xl border border-[var(--line)] bg-white px-4" value={state.category_id} onChange={(event) => setState((current) => ({ ...current, category_id: event.target.value }))}>
            <option value="">بدون قسم</option>
            {(categoriesQuery.data ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <Input placeholder="سعر الشراء" type="number" value={state.buy_price} onChange={(event) => setState((current) => ({ ...current, buy_price: event.target.value }))} />
          <Input placeholder="سعر البيع" type="number" value={state.price} onChange={(event) => setState((current) => ({ ...current, price: event.target.value }))} />
          <Input placeholder="الحد الأدنى" type="number" value={state.min_stock} onChange={(event) => setState((current) => ({ ...current, min_stock: event.target.value }))} />
          <Input placeholder="الانتهاء" type="datetime-local" value={state.expiry_date} onChange={(event) => setState((current) => ({ ...current, expiry_date: event.target.value }))} />
          <Input placeholder="باركودات إضافية مفصولة بفواصل" value={state.extra_barcodes} onChange={(event) => setState((current) => ({ ...current, extra_barcodes: event.target.value }))} />
          <label className="flex items-center gap-2 rounded-2xl border border-[var(--line)] px-4 py-3">
            <input type="checkbox" checked={state.track_expiry} onChange={(event) => setState((current) => ({ ...current, track_expiry: event.target.checked }))} />
            تتبع صلاحية
          </label>
          <label className="flex items-center gap-2 rounded-2xl border border-[var(--line)] px-4 py-3">
            <input type="checkbox" checked={state.track_batch} onChange={(event) => setState((current) => ({ ...current, track_batch: event.target.checked }))} />
            تتبع دفعات
          </label>
        </div>

        <div className="rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--muted)] px-4 py-3 text-sm">
          {state.productId ? (
            <span>
              سيتم تجهيز الصنف <span className="font-black">{state.name}</span> وربطه بالباركود <span className="font-mono font-black">{barcode || '—'}</span>.
            </span>
          ) : (
            'اختر صنفًا من المخزون أولًا حتى يتم ربط الباركود به.'
          )}
        </div>

        <div className="flex gap-3">
          <Button type="button" className="flex-1" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'جارٍ الحفظ...' : 'ربط الباركود وتجهيز البيع'}
          </Button>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function formatQuantity(value?: number | null) {
  const numeric = Number(value || 0)
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(3)
}
