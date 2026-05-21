import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { BarcodePrintDialog } from '@/features/products/barcode-print-dialog'
import { ProductSaleSetupForm, type ProductSaleSetupFormHandle } from '@/features/products/product-sale-setup-form'
import { apiGet, apiRequest } from '@/lib/api-client'
import { publishNotice } from '@/lib/notice-center'
import { storeSupportsWeightedProducts } from '@/lib/storefront'
import type { PrintableBarcodeResponse, Product } from '@/types/api'

async function fetchProducts() {
  return apiGet<Product[]>('/products')
}

function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(3)
}

function canDeleteFromProducts(product: Product) {
  return Number(product.stock || 0) <= 0 && !product.is_sellable && !String(product.barcode || '').trim()
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

function canPrintProductBarcode(product: Product) {
  return Boolean(product.is_sellable) && !product.is_weighted && isValidEAN13(String(product.barcode || '').trim())
}

export function ProductsPage() {
  const weightedEnabled = storeSupportsWeightedProducts()
  const queryClient = useQueryClient()
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const setupFormRef = useRef<ProductSaleSetupFormHandle | null>(null)
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null)
  const [printProductId, setPrintProductId] = useState<number | null>(null)
  const [blockedDeleteProductId, setBlockedDeleteProductId] = useState<number | null>(null)

  const productsQuery = useQuery({ queryKey: ['products'], queryFn: fetchProducts })

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase()
    return (productsQuery.data ?? []).filter((product) => {
      if (!query) return true
      return (
        product.name.toLowerCase().includes(query) ||
        String(product.barcode ?? '').includes(query) ||
        String(product.unit ?? '').toLowerCase().includes(query)
      )
    })
  }, [productsQuery.data, search])

  const selectedProduct = useMemo(
    () => rows.find((product) => product.id === selectedProductId) || null,
    [rows, selectedProductId],
  )

  const printProduct = useMemo(
    () => rows.find((product) => product.id === printProductId) || null,
    [rows, printProductId],
  )

  const blockedDeleteProduct = useMemo(
    () => rows.find((product) => product.id === blockedDeleteProductId) || null,
    [rows, blockedDeleteProductId],
  )

  const stats = useMemo(() => {
    const all = productsQuery.data ?? []
    return {
      total: all.length,
      sellable: all.filter((item) => item.is_sellable).length,
      pending: all.filter((item) => !item.is_sellable).length,
      weighted: weightedEnabled ? all.filter((item) => item.is_weighted).length : 0,
      noBarcode: all.filter(
        (item) => item.is_sellable && !(weightedEnabled && item.is_weighted) && !String(item.barcode || '').trim(),
      ).length,
    }
  }, [productsQuery.data, weightedEnabled])

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest<{ ok: true }>(`/products/${id}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      if (selectedProductId === id) {
        setSelectedProductId(null)
      }
      void queryClient.invalidateQueries({ queryKey: ['products'] })
      void queryClient.invalidateQueries({ queryKey: ['inventory'] })
      publishNotice('تم حذف الصنف بنجاح.', 'success')
    },
    onError: (error) => {
      publishNotice(error instanceof Error ? error.message : 'تعذر حذف الصنف.', 'error')
    },
  })

  useEffect(() => {
    const focusSearch = () => searchInputRef.current?.focus()
    const editSelected = () => {
      if (!selectedProduct) {
        publishNotice('اختر صنفًا من الجدول أولًا.', 'warning')
        return
      }
      setDialogOpen(true)
    }
    const saveCurrent = () => {
      if (!dialogOpen) return
      setupFormRef.current?.save()
    }

    window.addEventListener('flowpos:focus-search', focusSearch)
    window.addEventListener('flowpos:edit-selected-item', editSelected)
    window.addEventListener('flowpos:save-current-form', saveCurrent)

    return () => {
      window.removeEventListener('flowpos:focus-search', focusSearch)
      window.removeEventListener('flowpos:edit-selected-item', editSelected)
      window.removeEventListener('flowpos:save-current-form', saveCurrent)
    }
  }, [dialogOpen, selectedProduct])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <Input
            ref={searchInputRef}
            placeholder="ابحث عن صنف أو باركود أو وحدة..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => setDialogOpen(true)}>
            تجهيز سريع
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <StatCard title="إجمالي الأصناف" value={String(stats.total)} />
        <StatCard title="جاهزة للبيع" value={String(stats.sellable)} />
        <StatCard title="بانتظار الربط" value={String(stats.pending)} />
        {weightedEnabled ? <StatCard title="موزونة" value={String(stats.weighted)} /> : null}
        <StatCard title="بدون باركود" value={String(stats.noBarcode)} />
      </div>

      <Card className="min-h-0 flex-1 overflow-hidden p-0">
        <div className="h-full overflow-auto">
          <table className="w-full text-right">
            <thead className="sticky top-0 bg-[var(--muted)] text-sm">
              <tr className="border-b border-[var(--line)]">
                <th className="px-4 py-3">الصنف</th>
                <th className="px-4 py-3">الباركود</th>
                <th className="px-4 py-3">الوحدة</th>
                <th className="px-4 py-3">المخزون</th>
                <th className="px-4 py-3">البيع</th>
                <th className="px-4 py-3">حالة البيع</th>
                <th className="px-4 py-3">النوع</th>
                <th className="px-4 py-3">الإجراءات</th>
              </tr>
            </thead>
            <tbody>
              {productsQuery.isLoading ? (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={8}>
                    جارٍ تحميل الأصناف...
                  </td>
                </tr>
              ) : rows.length ? (
                rows.map((product) => {
                  const selected = product.id === selectedProductId
                  const deletable = canDeleteFromProducts(product)
                  const productKind =
                    weightedEnabled && product.is_weighted
                      ? 'موزون'
                      : String(product.barcode || '').trim()
                        ? 'عادي'
                        : product.is_sellable
                          ? 'بدون باركود'
                          : 'بانتظار الإعداد'

                  return (
                    <tr
                      key={product.id}
                      className={`cursor-pointer border-b border-[var(--line)] text-sm ${selected ? 'bg-orange-50/80' : ''}`}
                      onClick={() => setSelectedProductId(product.id)}
                      onDoubleClick={() => {
                        setSelectedProductId(product.id)
                        setDialogOpen(true)
                      }}
                    >
                      <td className="px-4 py-3 font-bold">{product.name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{product.barcode || 'بدون باركود'}</td>
                      <td className="px-4 py-3">{product.unit || '—'}</td>
                      <td className="px-4 py-3">{formatQuantity(product.stock)}</td>
                      <td className="px-4 py-3">{Number(product.price || 0).toFixed(2)}</td>
                      <td className="px-4 py-3">
                        <Badge className={product.is_sellable ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}>
                          {product.is_sellable ? 'جاهز للبيع' : 'بانتظار الربط'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">{productKind}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            className="h-9 rounded-xl px-3"
                            onClick={(event) => {
                              event.stopPropagation()
                              setSelectedProductId(product.id)
                              setDialogOpen(true)
                            }}
                          >
                            {product.is_sellable ? 'تعديل' : 'تجهيز للبيع'}
                          </Button>
                          {canPrintProductBarcode(product) ? (
                            <Button
                              type="button"
                              variant="secondary"
                              className="h-9 rounded-xl px-3"
                              onClick={(event) => {
                                event.stopPropagation()
                                setPrintProductId(product.id)
                              }}
                            >
                              طباعة باركود
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="secondary"
                            className="h-9 rounded-xl px-3 text-red-600"
                            onClick={(event) => {
                              event.stopPropagation()
                              if (!deletable) {
                                setBlockedDeleteProductId(product.id)
                                return
                              }
                              deleteMutation.mutate(product.id)
                            }}
                          >
                            حذف
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--text-muted)]" colSpan={8}>
                    لا توجد نتائج.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} className="max-w-4xl">
        <ProductSaleSetupForm
          ref={setupFormRef}
          initialProduct={selectedProduct}
          showCancel
          onCancel={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false)
          }}
        />
      </Dialog>

      <Dialog open={Boolean(blockedDeleteProduct)} onClose={() => setBlockedDeleteProductId(null)}>
        <div className="space-y-5 text-right">
          <div>
            <p className="text-sm font-bold text-orange-600">لا يمكن حذف المنتج</p>
            <h3 className="mt-2 text-2xl font-black text-[var(--text)]">{blockedDeleteProduct?.name}</h3>
          </div>
          <p className="leading-8 text-[var(--text-muted)]">
            لا يمكن حذف هذا المنتج لأنه مرتبط بسجل مخزني أو مشتريات أو مبيعات سابقة. إبقاء المنتج يحافظ على دقة
            الفواتير والتقارير وحركات المخزون.
          </p>
          <div className="flex justify-end">
            <Button type="button" onClick={() => setBlockedDeleteProductId(null)}>
              فهمت
            </Button>
          </div>
        </div>
      </Dialog>

      <BarcodePrintDialog
        open={Boolean(printProduct)}
        onClose={() => setPrintProductId(null)}
        productName={printProduct?.name || ''}
        initialUnit={printProduct?.unit}
        initialPrice={Number(printProduct?.price || 0)}
        onResolveBarcode={async () => {
          if (!printProduct) {
            throw new Error('لم يتم تحديد منتج للطباعة.')
          }
          const result = await apiRequest<PrintableBarcodeResponse>(`/products/${printProduct.id}/printable-barcode`, {
            method: 'POST',
          })
          void queryClient.invalidateQueries({ queryKey: ['products'] })
          return result
        }}
      />
    </div>
  )
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card variant="glass-subtle" className="rounded-[24px] p-4">
      <div className="text-sm text-[var(--text-muted)]">{title}</div>
      <div className="mt-2 text-3xl font-black">{value}</div>
    </Card>
  )
}
