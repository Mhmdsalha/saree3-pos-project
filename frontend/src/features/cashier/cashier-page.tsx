import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Barcode, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCashier } from '@/features/cashier/cashier-context'
import { printInvoice } from '@/features/cashier/print-invoice'
import { apiGet, resolveApiOrigin } from '@/lib/api-client'
import { loadCachedSellableProducts, saveCachedSellableProducts } from '@/lib/offline-db'
import { publishNotice } from '@/lib/notice-center'
import { storeSupportsWeightedProducts } from '@/lib/storefront'
import type { Category, Product } from '@/types/api'

type CashierTab = 'normal' | 'weighted' | 'no_barcode'

type CashierProductsResult = {
  items: Product[]
  source: 'live' | 'cache'
  fetchedAt: string | null
}

type CashierCategoryFilter = 'all' | number

async function fetchProducts() {
  const serverUrl = resolveApiOrigin(true)
  try {
    const items = await apiGet<Product[]>('/products?sellable_only=true')
    await saveCachedSellableProducts(serverUrl, items)
    return {
      items,
      source: 'live',
      fetchedAt: new Date().toISOString(),
    } satisfies CashierProductsResult
  } catch (error) {
    const cached = await loadCachedSellableProducts(serverUrl)
    if (cached) {
      return {
        items: cached.products,
        source: 'cache',
        fetchedAt: cached.fetchedAt,
      } satisfies CashierProductsResult
    }
    throw error
  }
}

async function fetchCategories() {
  return apiGet<Category[]>('/categories')
}

function formatStock(value: number) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(3)
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || target.isContentEditable || tag === 'select'
}

export function CashierPage() {
  const weightedEnabled = storeSupportsWeightedProducts()
  const [search, setSearch] = useState('')
  const [manualBarcode, setManualBarcode] = useState('')
  const [activeTab, setActiveTab] = useState<CashierTab>('normal')
  const [activeCategory, setActiveCategory] = useState<CashierCategoryFilter>('all')
  const [highlightedProductId, setHighlightedProductId] = useState<number | null>(null)
  const [manualPriceProduct, setManualPriceProduct] = useState<Product | null>(null)
  const [manualPrice, setManualPrice] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const manualBarcodeRef = useRef<HTMLInputElement | null>(null)
  const manualPriceInputRef = useRef<HTMLInputElement | null>(null)
  const deferredSearch = useDeferredValue(search)

  const {
    addProduct,
    addByBarcode,
    cancelInvoice,
    changeQty,
    lastInvoice,
    openCheckoutDialog,
    pendingStockDeltas,
    removeItem,
    selectedLineId,
    sendInvoicePdfToTelegram,
    setSelectedLineId,
    startFreshInvoice,
  } = useCashier()

  const parsedManualPrice = Number(manualPrice || 0)
  const manualUnitPrice = Number(manualPriceProduct?.price || 0)
  const manualDerivedQty =
    manualUnitPrice > 0 && parsedManualPrice > 0 ? Number((parsedManualPrice / manualUnitPrice).toFixed(3)) : 0
  const manualStock = Number(manualPriceProduct?.stock || 0)

  const productsQuery = useQuery({
    queryKey: ['products', 'cashier', resolveApiOrigin(true)],
    queryFn: fetchProducts,
  })

  const categoriesQuery = useQuery({
    queryKey: ['categories', 'cashier', resolveApiOrigin(true)],
    queryFn: fetchCategories,
    staleTime: 5 * 60_000,
  })

  const products = useMemo(() => {
    const withPendingOverlay = (productsQuery.data?.items ?? []).map((product) => {
      const estimatedStock = Number(product.stock ?? 0) - Number(pendingStockDeltas.get(product.id) || 0)
      return {
        ...product,
        stock: Number(Math.max(0, estimatedStock).toFixed(3)),
      }
    })

    return withPendingOverlay.filter((product) => {
      const q = deferredSearch.trim().toLowerCase()
      if (!q) return true
      return product.name.toLowerCase().includes(q) || String(product.barcode ?? '').includes(q)
    })
  }, [productsQuery.data?.items, deferredSearch, pendingStockDeltas])

  const groupedProducts = useMemo(
    () => ({
      normal: products.filter((product) => !(weightedEnabled && product.is_weighted) && Boolean(String(product.barcode || '').trim())),
      weighted: weightedEnabled ? products.filter((product) => product.is_weighted) : [],
      no_barcode: products.filter((product) => !(weightedEnabled && product.is_weighted) && !String(product.barcode || '').trim()),
    }),
    [products, weightedEnabled],
  )

  const categoryNameMap = useMemo(
    () =>
      new Map<number, string>(
        (categoriesQuery.data ?? []).map((category) => [category.id, category.name]),
      ),
    [categoriesQuery.data],
  )

  const categoryOptions = useMemo(() => {
    const options = new Map<number, string>()
    for (const product of groupedProducts[activeTab]) {
      if (!product.category_id) continue
      options.set(product.category_id, categoryNameMap.get(product.category_id) ?? `القسم ${product.category_id}`)
    }
    return [...options.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ar'))
  }, [activeTab, categoryNameMap, groupedProducts])

  const visibleProducts = useMemo(() => {
    const scopedProducts =
      activeCategory === 'all'
        ? groupedProducts[activeTab]
        : groupedProducts[activeTab].filter((product) => product.category_id === activeCategory)

    return [...scopedProducts].sort((left, right) => {
      const leftCategory = categoryNameMap.get(left.category_id ?? -1) ?? ''
      const rightCategory = categoryNameMap.get(right.category_id ?? -1) ?? ''
      const categoryOrder = activeCategory === 'all' ? leftCategory.localeCompare(rightCategory, 'ar') : 0
      if (categoryOrder !== 0) return categoryOrder
      return left.name.localeCompare(right.name, 'ar')
    })
  }, [activeCategory, activeTab, categoryNameMap, groupedProducts])

  useEffect(() => {
    setActiveCategory('all')
  }, [activeTab])

  useEffect(() => {
    if (!weightedEnabled && activeTab === 'weighted') {
      setActiveTab('normal')
    }
  }, [activeTab, weightedEnabled])

  useEffect(() => {
    if (activeCategory === 'all') return
    if (!categoryOptions.some((category) => category.id === activeCategory)) {
      setActiveCategory('all')
    }
  }, [activeCategory, categoryOptions])

  useEffect(() => {
    if (!visibleProducts.length) {
      setHighlightedProductId(null)
      return
    }
    if (!visibleProducts.some((product) => product.id === highlightedProductId)) {
      setHighlightedProductId(visibleProducts[0]?.id ?? null)
    }
  }, [visibleProducts, highlightedProductId])

  useEffect(() => {
    if (manualPriceProduct) {
      window.setTimeout(() => manualPriceInputRef.current?.focus(), 0)
    }
  }, [manualPriceProduct])

  const handleSelectProduct = (product: Product) => {
    if (weightedEnabled && product.is_weighted) {
      setManualPriceProduct(product)
      setManualPrice('')
      return
    }
    addProduct(product)
  }

  const handleManualBarcode = () => {
    if (!manualBarcode.trim()) return
    const added = addByBarcode(manualBarcode, productsQuery.data?.items ?? [])
    if (!added) {
      publishNotice('لم يتم العثور على منتج مطابق لهذا الباركود.', 'error')
      return
    }
    setManualBarcode('')
  }

  const cycleTab = (direction: 1 | -1) => {
    const tabs: CashierTab[] = weightedEnabled ? ['normal', 'weighted', 'no_barcode'] : ['normal', 'no_barcode']
    const index = tabs.indexOf(activeTab)
    const nextIndex = (index + direction + tabs.length) % tabs.length
    setActiveTab(tabs[nextIndex])
  }

  const confirmManualPrice = () => {
    if (!manualPriceProduct) return
    if (parsedManualPrice <= 0) {
      publishNotice('أدخل السعر النهائي أولًا.', 'error')
      return
    }
    if (manualDerivedQty <= 0) {
      publishNotice('تعذر احتساب الكمية المباعة لهذا المنتج.', 'error')
      return
    }
    if (manualDerivedQty > manualStock) {
      publishNotice('المخزون المتاح لا يكفي لهذا السعر النهائي.', 'error')
      return
    }
    addProduct(manualPriceProduct, manualDerivedQty, manualUnitPrice, parsedManualPrice)
    setManualPriceProduct(null)
  }

  useEffect(() => {
    const focusSearch = () => searchInputRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F10') {
        event.preventDefault()
        startFreshInvoice()
        return
      }

      if (event.key === 'F2') {
        event.preventDefault()
        focusSearch()
        return
      }

      if (event.key === 'F3') {
        event.preventDefault()
        openCheckoutDialog()
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('flowpos:focus-customer-name'))
        }, 40)
        return
      }

      if (event.key === 'F4') {
        event.preventDefault()
        openCheckoutDialog()
        return
      }

      if (event.key === 'F6') {
        event.preventDefault()
        cycleTab(1)
        return
      }

      if (event.key === 'F7') {
        event.preventDefault()
        if (!lastInvoice) {
          publishNotice('لا توجد فاتورة محفوظة لإرسالها.', 'warning')
          return
        }
        void sendInvoicePdfToTelegram(lastInvoice.id)
        return
      }

      if (event.key === 'F8') {
        event.preventDefault()
        cancelInvoice()
        return
      }

      if (event.key === 'F9') {
        event.preventDefault()
        if (!lastInvoice) {
          publishNotice('لا توجد فاتورة محفوظة للطباعة.', 'warning')
          return
        }
        void printInvoice(lastInvoice.id, lastInvoice.cashier_name || '')
        return
      }

      if (manualPriceProduct && event.key === 'Escape') {
        event.preventDefault()
        setManualPriceProduct(null)
        return
      }

      if (manualPriceProduct && event.key === 'Enter') {
        event.preventDefault()
        confirmManualPrice()
        return
      }

      if (isEditableTarget(event.target)) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (!visibleProducts.length) return
        const index = visibleProducts.findIndex((product) => product.id === highlightedProductId)
        const next = visibleProducts[(index + 1 + visibleProducts.length) % visibleProducts.length]
        setHighlightedProductId(next.id)
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (!visibleProducts.length) return
        const index = visibleProducts.findIndex((product) => product.id === highlightedProductId)
        const next = visibleProducts[(index - 1 + visibleProducts.length) % visibleProducts.length]
        setHighlightedProductId(next.id)
        return
      }

      if (event.key === 'Enter') {
        const highlighted = visibleProducts.find((product) => product.id === highlightedProductId)
        if (!highlighted) return
        event.preventDefault()
        handleSelectProduct(highlighted)
        return
      }

      if (event.key === '+' || event.key === '=') {
        if (selectedLineId) {
          event.preventDefault()
          changeQty(selectedLineId, 1)
        }
        return
      }

      if (event.key === '-') {
        if (selectedLineId) {
          event.preventDefault()
          changeQty(selectedLineId, -1)
        }
        return
      }

      if (event.key === 'Delete' || (event.ctrlKey && event.key === 'Backspace')) {
        if (selectedLineId) {
          event.preventDefault()
          removeItem(selectedLineId)
          setSelectedLineId(null)
        }
      }
    }

    const onFocusSearch = () => focusSearch()

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('flowpos:focus-search', onFocusSearch)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('flowpos:focus-search', onFocusSearch)
    }
  }, [
    activeTab,
    cancelInvoice,
    changeQty,
    highlightedProductId,
    lastInvoice,
    manualDerivedQty,
    manualPriceProduct,
    manualStock,
    openCheckoutDialog,
    parsedManualPrice,
    removeItem,
    selectedLineId,
    sendInvoicePdfToTelegram,
    setSelectedLineId,
    visibleProducts,
    manualUnitPrice,
  ])

  const tabMeta = [
    { id: 'normal', label: 'المنتجات العادية', count: groupedProducts.normal.length },
    { id: 'weighted', label: 'المنتجات الموزونة', count: groupedProducts.weighted.length },
    { id: 'no_barcode', label: 'بدون باركود', count: groupedProducts.no_barcode.length },
  ].filter((tab) => weightedEnabled || tab.id !== 'weighted') as Array<{ id: CashierTab; label: string; count: number }>

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-faint)]" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="ابحث عن منتج..."
            className="pr-10"
          />
        </div>
        <div className="relative">
          <Barcode className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-faint)]" />
          <Input
            ref={manualBarcodeRef}
            value={manualBarcode}
            onChange={(event) => setManualBarcode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleManualBarcode()
            }}
            placeholder="إدخال باركود (Enter)..."
            className="pr-10"
          />
        </div>
        <Button type="button" className="h-10 rounded-2xl px-4" onClick={startFreshInvoice}>
          + فاتورة جديدة
        </Button>
      </div>

      {productsQuery.data?.source === 'cache' ? (
        <Card className="rounded-[22px] border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-none">
          تعمل شاشة الكاشير الآن على نسخة منتجات محفوظة محليًا بسبب انقطاع الاتصال.
        </Card>
      ) : null}

      <div className="flex items-center gap-2 border-b border-dashed border-[var(--line)] pb-3">
        {tabMeta.map((tab) => (
          <Button
            key={tab.id}
            type="button"
            variant={activeTab === tab.id ? 'default' : 'secondary'}
            className="rounded-2xl"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label} ({tab.count})
          </Button>
        ))}
      </div>

      {categoryOptions.length ? (
        <div className="flex items-center gap-3 border-b border-dashed border-[var(--line)] pb-3">
          <div className="shrink-0 text-sm font-black text-[var(--text-muted)]">القسم</div>
          <select
            className="h-11 min-w-[220px] rounded-2xl border border-[var(--line)] bg-white px-4 text-sm font-semibold outline-none"
            value={String(activeCategory)}
            onChange={(event) => {
              const value = event.target.value
              setActiveCategory(value === 'all' ? 'all' : Number(value))
            }}
          >
            <option value="all">كل الأقسام</option>
            {categoryOptions.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="mt-1 flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
        {productsQuery.isLoading ? (
          <Card className="flex min-h-40 items-center justify-center p-6 text-sm text-[var(--text-muted)]">جارٍ تحميل المنتجات...</Card>
        ) : productsQuery.isError ? (
          <Card className="flex min-h-40 items-center justify-center p-6 text-center text-sm text-red-700">
            تعذر تحميل المنتجات، ولا توجد نسخة محلية محفوظة متاحة لهذا الجهاز.
          </Card>
        ) : (
          <section className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden">
            <div className="text-sm font-black text-[var(--text-muted)]">
              {activeTab === 'normal'
                ? 'منتجات الباركود العادية'
                : activeTab === 'weighted'
                  ? 'منتجات السعر النهائي الموزونة'
                  : 'منتجات قابلة للبيع بدون باركود'}
            </div>
            <div className="grid min-h-0 auto-rows-min grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 overflow-y-auto px-1 py-1">
              {visibleProducts.length ? (
                visibleProducts.map((product) => {
                  const selected = highlightedProductId === product.id
                  return (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => handleSelectProduct(product)}
                      onMouseEnter={() => setHighlightedProductId(product.id)}
                      className={`rounded-[20px] px-3 py-3 text-right shadow-[0_8px_22px_rgba(15,23,42,0.05)] transition-transform hover:-translate-y-px ${
                        activeTab === 'weighted'
                          ? `border ${selected ? 'border-[var(--brand)] ring-2 ring-orange-200' : 'border-orange-200'} bg-orange-50/40`
                          : `border ${selected ? 'border-[var(--brand-soft)] ring-2 ring-orange-200' : 'border-[var(--line)]'} bg-white`
                      }`}
                    >
                      <div className="truncate text-sm font-bold leading-6">{product.name}</div>
                      <div className="mt-1 text-[11px] font-bold text-orange-700">
                        {activeTab === 'weighted' ? 'سعر الوحدة: ' : 'السعر: '}
                        {Number(product.price || 0).toFixed(2)}
                      </div>
                      {activeTab === 'weighted' ? (
                        <div className="mt-2 rounded-2xl border border-orange-200 px-3 py-2 text-xs text-[var(--text-muted)]">
                          أدخل السعر النهائي فقط، وسيتم احتساب الكمية تلقائيًا
                        </div>
                      ) : (
                        <div className="mt-2 flex items-center justify-between rounded-2xl border border-[var(--line)] px-3 py-2 text-[11px]">
                          <span className="text-[var(--text-muted)]">المتوفر</span>
                          <span className="text-xs font-black">{formatStock(Number(product.stock ?? 0))}</span>
                        </div>
                      )}
                    </button>
                  )
                })
              ) : (
                <Card className="col-span-full flex min-h-24 items-center justify-center p-5 text-sm text-[var(--text-muted)]">
                  لا توجد منتجات مطابقة في هذا التبويب.
                </Card>
              )}
            </div>
          </section>
        )}
      </div>

      <Dialog open={Boolean(manualPriceProduct)} onClose={() => setManualPriceProduct(null)}>
        <div className="space-y-4">
          <div className="text-center">
            <div className="text-2xl font-black">{manualPriceProduct?.name}</div>
            <div className="mt-2 text-sm text-[var(--text-muted)]">
              أدخل السعر النهائي المكتوب على العبوة، وسيتم احتساب الكمية المخصومة من المخزون تلقائيًا.
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Card className="rounded-2xl border-[var(--line)] bg-[var(--muted)]/40 p-3 shadow-none">
              <div className="text-xs text-[var(--text-muted)]">وحدة المخزون</div>
              <div className="mt-1 text-base font-black">{manualPriceProduct?.unit || 'وحدة'}</div>
            </Card>
            <Card className="rounded-2xl border-[var(--line)] bg-[var(--muted)]/40 p-3 shadow-none">
              <div className="text-xs text-[var(--text-muted)]">سعر الوحدة المرجعي</div>
              <div className="mt-1 text-base font-black">{manualUnitPrice.toFixed(2)}</div>
            </Card>
          </div>

          <Input
            ref={manualPriceInputRef}
            type="number"
            min="0"
            step="0.01"
            value={manualPrice}
            onChange={(event) => setManualPrice(event.target.value)}
            placeholder="أدخل السعر النهائي"
          />

          <Card className="rounded-2xl border-[var(--line)] bg-[var(--muted)]/40 p-3 shadow-none">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-[var(--text-muted)]">الكمية المخصومة من المخزون</span>
              <span className="font-black">
                {manualDerivedQty > 0 ? `${manualDerivedQty.toFixed(3)} ${manualPriceProduct?.unit || ''}`.trim() : '—'}
              </span>
            </div>
            <div className="mt-2 text-xs text-[var(--text-muted)]">
              المتوفر حاليًا: {formatStock(manualStock)} {manualPriceProduct?.unit || ''}
            </div>
          </Card>

          <div className="flex gap-3">
            <Button
              type="button"
              className="flex-1"
              onClick={confirmManualPrice}
              disabled={!manualPriceProduct || parsedManualPrice <= 0 || manualDerivedQty <= 0 || manualDerivedQty > manualStock}
            >
              إضافة
            </Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setManualPriceProduct(null)}>
              إلغاء
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
