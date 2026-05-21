import {
  forwardRef,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { BarcodePrintDialog } from '@/features/products/barcode-print-dialog'
import { apiGet, apiRequest } from '@/lib/api-client'
import { publishNotice } from '@/lib/notice-center'
import { storeSupportsWeightedProducts } from '@/lib/storefront'
import type { Category, Product, ProductPrepareForSalePayload, ProductSetupCandidate } from '@/types/api'

type ProductKind = 'normal' | 'weighted' | 'no_barcode'

type SetupFormState = {
  productId?: number
  search: string
  name: string
  barcode: string
  category_id: string
  buy_price: string
  price: string
  min_stock: string
  unit: string
  productType: ProductKind
  track_expiry: boolean
  track_batch: boolean
  expiry_date: string
  extra_barcodes: string
}

export type ProductSaleSetupFormHandle = {
  focusSearch: () => void
  save: () => void
  openProduct: (product: Product) => void
}

type ProductSaleSetupFormProps = {
  initialProduct?: Product | null
  title?: string
  subtitle?: string
  submitLabel?: string
  showCancel?: boolean
  onCancel?: () => void
  onSaved?: (product: Product) => void
}

const emptySetupForm: SetupFormState = {
  search: '',
  name: '',
  barcode: '',
  category_id: '',
  buy_price: '',
  price: '',
  min_stock: '5',
  unit: '',
  productType: 'normal',
  track_expiry: false,
  track_batch: false,
  expiry_date: '',
  extra_barcodes: '',
}

async function fetchProducts() {
  return apiGet<Product[]>('/products')
}

async function fetchCategories() {
  return apiGet<Category[]>('/categories')
}

async function fetchGeneratedBarcode() {
  return apiGet<{ barcode: string }>('/products/generate-barcode')
}

async function searchSetupCandidates(query: string) {
  return apiGet<ProductSetupCandidate[]>(`/products/setup-candidates?q=${encodeURIComponent(query)}&limit=10`)
}

function resolveProductType(product: Product, weightedEnabled: boolean): ProductKind {
  if (product.is_weighted && weightedEnabled) return 'weighted'
  if (product.is_sellable && !String(product.barcode || '').trim()) return 'no_barcode'
  return 'normal'
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

export const ProductSaleSetupForm = forwardRef<ProductSaleSetupFormHandle, ProductSaleSetupFormProps>(
  function ProductSaleSetupForm(
    {
      initialProduct = null,
      title = 'تجهيز الصنف للبيع',
      subtitle = 'اختر صنفًا دخل عبر المخزون أولًا، ثم اربطه بالباركود أو جهزه للبيع بدون باركود حسب نوعه.',
      submitLabel = 'حفظ التجهيز للبيع',
      showCancel = false,
      onCancel,
      onSaved,
    },
    ref,
  ) {
    const queryClient = useQueryClient()
    const weightedEnabled = storeSupportsWeightedProducts()
    const [setupForm, setSetupForm] = useState<SetupFormState>(emptySetupForm)
    const [printDialogOpen, setPrintDialogOpen] = useState(false)
    const searchInputRef = useRef<HTMLInputElement | null>(null)
    const deferredCandidateSearch = useDeferredValue(setupForm.search)

    const productsQuery = useQuery({ queryKey: ['products'], queryFn: fetchProducts })
    const categoriesQuery = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
    const candidatesQuery = useQuery({
      queryKey: ['product-setup-candidates', deferredCandidateSearch],
      queryFn: () => searchSetupCandidates(deferredCandidateSearch),
      enabled: deferredCandidateSearch.trim().length > 0,
    })

    const productMap = useMemo(
      () => new Map((productsQuery.data ?? []).map((product) => [product.id, product])),
      [productsQuery.data],
    )

    const selectedProduct = useMemo(() => {
      if (!setupForm.productId) return null
      return productMap.get(setupForm.productId) || initialProduct || null
    }, [initialProduct, productMap, setupForm.productId])

    const fillFromProduct = (product: Product) => {
      setSetupForm({
        productId: product.id,
        search: product.name,
        name: product.name,
        barcode: String(product.barcode ?? ''),
        category_id: product.category_id ? String(product.category_id) : '',
        buy_price: String(product.buy_price ?? 0),
        price: String(product.price ?? ''),
        min_stock: String(product.min_stock ?? 5),
        unit: product.unit || '',
        productType: resolveProductType(product, weightedEnabled),
        track_expiry: Boolean(product.track_expiry),
        track_batch: Boolean(product.track_batch),
        expiry_date: product.expiry_date ? String(product.expiry_date).slice(0, 16) : '',
        extra_barcodes: (product.extra_barcodes || []).map((item) => item.barcode).join(', '),
      })
    }

    useEffect(() => {
      if (initialProduct) {
        fillFromProduct(initialProduct)
      } else {
        setSetupForm(emptySetupForm)
      }
    }, [initialProduct, weightedEnabled])

    useEffect(() => {
      if (!weightedEnabled && setupForm.productType === 'weighted') {
        setSetupForm((current) => ({ ...current, productType: 'no_barcode' }))
      }
    }, [setupForm.productType, weightedEnabled])

    const selectCandidate = (candidateId: number) => {
      const product = productMap.get(candidateId)
      if (!product) return
      fillFromProduct(product)
    }

    const validateSetup = () => {
      if (!setupForm.productId) return 'اختر صنفًا موجودًا من المخزون أولًا.'
      if (!setupForm.name.trim()) return 'اسم الصنف مطلوب.'
      if (!setupForm.unit.trim()) return 'وحدة المخزون مطلوبة.'
      if (Number(setupForm.min_stock || 0) < 0) return 'الحد الأدنى غير صالح.'
      if (Number(setupForm.buy_price || 0) < 0) return 'سعر الشراء غير صالح.'

      if (setupForm.productType === 'weighted') {
        if (!weightedEnabled) return 'المنتجات الموزونة متاحة فقط لمتاجر السوبرماركت.'
        if (Number(setupForm.price || 0) <= 0) return 'سعر الوحدة المرجعي مطلوب للمنتج الموزون.'
        return ''
      }

      if (setupForm.productType === 'no_barcode') {
        if (Number(setupForm.price || 0) <= 0) return 'سعر البيع مطلوب.'
        return ''
      }

      const cleanBarcode = setupForm.barcode.trim()
      if (!cleanBarcode) return 'الباركود الأساسي مطلوب.'
      if (!isValidEAN13(cleanBarcode)) return 'الباركود يجب أن يكون EAN-13 صالحًا.'
      if (Number(setupForm.price || 0) <= 0) return 'سعر البيع مطلوب.'

      const extraBarcodes = setupForm.extra_barcodes
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      if (extraBarcodes.some((item) => item === cleanBarcode)) {
        return 'لا تضف الباركود الأساسي ضمن الباركودات الإضافية.'
      }
      for (const barcode of extraBarcodes) {
        if (!isValidEAN13(barcode)) {
          return `الباركود الإضافي ${barcode} غير صالح.`
        }
      }
      return ''
    }

    const saveMutation = useMutation({
      mutationFn: async (payload: { productId: number; body: ProductPrepareForSalePayload }) => {
        return apiRequest<Product>(`/products/${payload.productId}/prepare-for-sale`, {
          method: 'POST',
          body: JSON.stringify(payload.body),
        })
      },
      onSuccess: (savedProduct) => {
        publishNotice('تم تجهيز الصنف للبيع بنجاح.', 'success')
        void queryClient.invalidateQueries({ queryKey: ['products'] })
        void queryClient.invalidateQueries({ queryKey: ['inventory'] })
        onSaved?.(savedProduct)
      },
      onError: (error) => {
        publishNotice(error instanceof Error ? error.message : 'تعذر تجهيز الصنف للبيع.', 'error')
      },
    })

    const buildPreparePayload = (): ProductPrepareForSalePayload => {
      const effectiveProductType =
        !weightedEnabled && setupForm.productType === 'weighted' ? 'no_barcode' : setupForm.productType

      return {
        barcode: effectiveProductType === 'normal' ? setupForm.barcode.trim() : null,
        name: setupForm.name.trim(),
        category_id: setupForm.category_id ? Number(setupForm.category_id) : null,
        buy_price: Number(setupForm.buy_price || 0),
        price: Number(setupForm.price || 0),
        min_stock: Number(setupForm.min_stock || 5),
        unit: setupForm.unit.trim(),
        is_weighted: effectiveProductType === 'weighted',
        sell_without_barcode: effectiveProductType === 'no_barcode',
        track_expiry: setupForm.track_expiry,
        track_batch: setupForm.track_batch,
        expiry_date: setupForm.expiry_date ? new Date(setupForm.expiry_date).toISOString() : null,
        extra_barcodes:
          effectiveProductType === 'normal'
            ? setupForm.extra_barcodes
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
            : [],
      }
    }

    const saveSetup = async () => {
      const validationError = validateSetup()
      if (validationError) {
        publishNotice(validationError, 'error')
        return
      }

      await saveMutation.mutateAsync({
        productId: setupForm.productId as number,
        body: buildPreparePayload(),
      })
    }

    const canOpenPrintDialog =
      Boolean(setupForm.productId) &&
      setupForm.productType === 'normal' &&
      isValidEAN13(setupForm.barcode.trim())

    const openPrintDialog = () => {
      if (!setupForm.productId) {
        publishNotice('اختر صنفًا من المخزون أولًا قبل الطباعة.', 'warning')
        return
      }
      if (setupForm.productType !== 'normal') {
        publishNotice('الطباعة متاحة فقط للمنتج العادي الذي يملك باركودًا.', 'warning')
        return
      }
      if (!isValidEAN13(setupForm.barcode.trim())) {
        publishNotice('ولّد باركودًا صالحًا أولًا ثم اضغط طباعة.', 'warning')
        return
      }
      setPrintDialogOpen(true)
    }

    useImperativeHandle(ref, () => ({
      focusSearch: () => searchInputRef.current?.focus(),
      save: () => {
        void saveSetup()
      },
      openProduct: (product: Product) => fillFromProduct(product),
    }))

    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <div className="text-3xl font-black">{title}</div>
          <div className="text-sm text-[var(--text-muted)]">{subtitle}</div>
        </div>

        <div className="space-y-3">
          <Input
            ref={searchInputRef}
            placeholder="اكتب اسم الصنف للبحث في المخزون"
            value={setupForm.search}
            onChange={(event) =>
              setSetupForm((current) => ({ ...current, search: event.target.value, productId: current.productId }))
            }
          />
          <div className="max-h-56 overflow-auto rounded-[24px] border border-[var(--line)] bg-[var(--muted)] p-2">
            <div className="grid gap-2">
              {(candidatesQuery.data ?? []).map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => selectCandidate(candidate.id)}
                  className={`rounded-[20px] border px-4 py-3 text-right ${
                    setupForm.productId === candidate.id ? 'border-[var(--brand)] bg-orange-50' : 'border-[var(--line)] bg-white'
                  }`}
                >
                  <div className="font-black">{candidate.name}</div>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    {candidate.unit || 'بدون وحدة'} • مخزون {formatQuantity(candidate.stock)} •{' '}
                    {candidate.is_sellable ? 'جاهز للبيع' : 'بانتظار الربط'}
                  </div>
                </button>
              ))}
              {!candidatesQuery.isFetching && setupForm.search.trim() && !(candidatesQuery.data ?? []).length ? (
                <div className="rounded-[20px] bg-white px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                  لا توجد أصناف مطابقة لهذا البحث.
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <Card className="space-y-3 rounded-[24px] p-4 shadow-none">
            <div className="text-sm font-bold text-[var(--text-muted)]">بيانات الصنف</div>
            <Input
              placeholder="اسم الصنف"
              value={setupForm.name}
              onChange={(event) => setSetupForm((current) => ({ ...current, name: event.target.value }))}
            />
            <select
              className="h-12 rounded-2xl border border-[var(--line)] bg-white px-4"
              value={setupForm.category_id}
              onChange={(event) => setSetupForm((current) => ({ ...current, category_id: event.target.value }))}
            >
              <option value="">بدون قسم</option>
              {(categoriesQuery.data ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <Input
              placeholder="وحدة المخزون"
              value={setupForm.unit}
              onChange={(event) => setSetupForm((current) => ({ ...current, unit: event.target.value }))}
            />

            <div className={`grid gap-2 ${weightedEnabled ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <Button
                type="button"
                variant={setupForm.productType === 'normal' ? 'default' : 'secondary'}
                onClick={() => setSetupForm((current) => ({ ...current, productType: 'normal' }))}
              >
                عادي
              </Button>
              {weightedEnabled ? (
                <Button
                  type="button"
                  variant={setupForm.productType === 'weighted' ? 'default' : 'secondary'}
                  onClick={() => setSetupForm((current) => ({ ...current, productType: 'weighted' }))}
                >
                  موزون
                </Button>
              ) : null}
              <Button
                type="button"
                variant={setupForm.productType === 'no_barcode' ? 'default' : 'secondary'}
                onClick={() => setSetupForm((current) => ({ ...current, productType: 'no_barcode' }))}
              >
                بدون باركود
              </Button>
            </div>

            {setupForm.productType === 'normal' ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Input
                    placeholder="الباركود الأساسي"
                    value={setupForm.barcode}
                    onChange={(event) => setSetupForm((current) => ({ ...current, barcode: event.target.value }))}
                    className="min-w-[220px] flex-1"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={async () => {
                      const generated = await fetchGeneratedBarcode()
                      setSetupForm((current) => ({ ...current, barcode: generated.barcode }))
                    }}
                  >
                    توليد
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={openPrintDialog}
                    title={canOpenPrintDialog ? 'طباعة الباركود الحالي' : 'ولّد باركودًا صالحًا أولًا'}
                  >
                    طباعة باركود
                  </Button>
                </div>
                <Input
                  placeholder="باركودات إضافية مفصولة بفواصل"
                  value={setupForm.extra_barcodes}
                  onChange={(event) => setSetupForm((current) => ({ ...current, extra_barcodes: event.target.value }))}
                />
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--line)] bg-[var(--muted)] px-4 py-3 text-sm text-[var(--text-muted)]">
                <div>
                  {setupForm.productType === 'weighted'
                    ? 'الصنف الموزون لا يحتاج باركود بيع في هذا المسار.'
                    : 'سيصبح هذا الصنف جاهزًا للبيع والبحث اليدوي داخل الكاشير بدون باركود أساسي.'}
                </div>
              </div>
            )}
          </Card>

          <Card className="space-y-3 rounded-[24px] p-4 shadow-none">
            <div className="text-sm font-bold text-[var(--text-muted)]">البيع والمخزون</div>
            <Input
              placeholder="سعر الشراء"
              type="number"
              value={setupForm.buy_price}
              onChange={(event) => setSetupForm((current) => ({ ...current, buy_price: event.target.value }))}
            />
            <Input
              placeholder={setupForm.productType === 'weighted' ? 'سعر الوحدة المرجعي' : 'سعر البيع'}
              type="number"
              value={setupForm.price}
              onChange={(event) => setSetupForm((current) => ({ ...current, price: event.target.value }))}
            />
            <Input
              placeholder="الحد الأدنى"
              type="number"
              value={setupForm.min_stock}
              onChange={(event) => setSetupForm((current) => ({ ...current, min_stock: event.target.value }))}
            />
            <Input
              placeholder="الانتهاء"
              type="datetime-local"
              value={setupForm.expiry_date}
              onChange={(event) => setSetupForm((current) => ({ ...current, expiry_date: event.target.value }))}
            />
            <label className="flex items-center gap-2 rounded-2xl border border-[var(--line)] px-4 py-3">
              <input
                type="checkbox"
                checked={setupForm.track_expiry}
                onChange={(event) => setSetupForm((current) => ({ ...current, track_expiry: event.target.checked }))}
              />
              تتبع صلاحية
            </label>
            <label className="flex items-center gap-2 rounded-2xl border border-[var(--line)] px-4 py-3">
              <input
                type="checkbox"
                checked={setupForm.track_batch}
                onChange={(event) => setSetupForm((current) => ({ ...current, track_batch: event.target.checked }))}
              />
              تتبع دفعات
            </label>
          </Card>
        </div>

        <div className="flex gap-3">
          <Button type="button" className="flex-1" onClick={() => void saveSetup()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'جارٍ الحفظ...' : submitLabel}
          </Button>
          {showCancel ? (
            <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
              إلغاء
            </Button>
          ) : null}
        </div>

        <BarcodePrintDialog
          open={printDialogOpen}
          onClose={() => setPrintDialogOpen(false)}
          productName={setupForm.name.trim() || selectedProduct?.name || 'الصنف'}
          initialBarcode={setupForm.productType === 'normal' ? setupForm.barcode.trim() : undefined}
          initialUnit={setupForm.unit}
          initialPrice={Number(setupForm.price || 0)}
          title="طباعة باركود الصنف"
          description="اطبع باركود المنتج العادي بعدد النسخ الذي تحتاجه. المنتجات بدون باركود لا تُطبع لها ملصقات باركود."
          onResolveBarcode={async () => {
            if (!setupForm.productId) {
              throw new Error('اختر صنفًا أولًا قبل الطباعة.')
            }
            if (setupForm.productType !== 'normal') {
              throw new Error('طباعة الباركود متاحة فقط للمنتج العادي الذي يملك باركودًا.')
            }

            const cleanBarcode = setupForm.barcode.trim()
            if (!isValidEAN13(cleanBarcode)) {
              throw new Error('ولّد باركودًا صالحًا أو أدخل باركود EAN-13 قبل الطباعة.')
            }

            return {
              barcode: cleanBarcode,
              product_name: setupForm.name.trim() || selectedProduct?.name || 'الصنف',
              unit: setupForm.unit,
              price: Number(setupForm.price || 0),
            }
          }}
          onPrinted={() => {
            void queryClient.invalidateQueries({ queryKey: ['products'] })
          }}
        />
      </div>
    )
  },
)

function formatQuantity(value?: number | null) {
  const numeric = Number(value || 0)
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(3)
}
