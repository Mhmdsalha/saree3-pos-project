import { useState } from 'react'
import { Minus, PackageOpen, Plus, ReceiptText, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCashier } from '@/features/cashier/cashier-context'
import { publishNotice } from '@/lib/notice-center'
import { formatMoneyWithCurrency } from '@/lib/storefront'

function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(3)
}

function paymentMethodText(value: string) {
  if (value === 'cash') return 'نقدي'
  if (value === 'card') return 'بطاقة'
  if (value === 'digital') return 'رقمي'
  return value
}

function getPendingInvoiceLines(invoice: ReturnType<typeof useCashier>['pendingInvoices'][number]) {
  if (invoice.summary.items?.length) {
    return invoice.summary.items.map((item, index) => ({
      key: `${invoice.localId}-${item.productId}-${index}`,
      name: item.name || `الصنف #${item.productId}`,
      quantity: item.quantity,
      price: item.price,
      lineTotal: item.lineTotal,
      unit: item.unit || null,
    }))
  }

  return invoice.payload.items.map((item, index) => ({
    key: `${invoice.localId}-${item.product_id}-${index}`,
    name: `الصنف #${item.product_id}`,
    quantity: item.quantity,
    price: item.price,
    lineTotal: item.price * item.quantity,
    unit: null,
  }))
}

export function InvoicePanel() {
  const {
    invoiceItems,
    selectedLineId,
    subtotal,
    total,
    totalQty,
    discount,
    customerName,
    lastScanAt,
    heldInvoices,
    pendingInvoices,
    setDiscount,
    changeQty,
    removeItem,
    setSelectedLineId,
    holdInvoice,
    restoreHeldInvoice,
    cancelInvoice,
    openCheckoutDialog,
    syncPendingInvoices,
    syncPendingInvoice,
    removePendingInvoice,
    syncState,
    isSubmitting,
  } = useCashier()

  const [discountDialogOpen, setDiscountDialogOpen] = useState(false)
  const [heldDialogOpen, setHeldDialogOpen] = useState(false)
  const [holdNameDialogOpen, setHoldNameDialogOpen] = useState(false)
  const [queueDialogOpen, setQueueDialogOpen] = useState(false)
  const [discountValue, setDiscountValue] = useState(String(discount || ''))
  const [holdCustomerName, setHoldCustomerName] = useState(customerName)
  const [expandedPendingInvoiceId, setExpandedPendingInvoiceId] = useState<string | null>(null)

  return (
    <aside className="flex h-full min-h-0 self-stretch flex-col overflow-hidden rounded-[28px] border border-[var(--line)] bg-[var(--app-bg)] p-4 shadow-none">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-black">الفاتورة</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {invoiceItems.length} أصناف • {formatQuantity(totalQty)} إجمالي
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" className="h-9 rounded-2xl px-3" onClick={() => setHeldDialogOpen(true)} disabled={!heldInvoices.length}>
            <PackageOpen className="h-4 w-4" />
            {heldInvoices.length ? `الفواتير المعلقة (${heldInvoices.length})` : 'الفواتير المعلقة'}
          </Button>
          <Button type="button" variant="secondary" className="h-9 rounded-2xl px-3" onClick={() => setQueueDialogOpen(true)} disabled={!pendingInvoices.length}>
            <ReceiptText className="h-4 w-4" />
            {pendingInvoices.length ? `الفواتير المؤجلة (${pendingInvoices.length})` : 'الفواتير المؤجلة'}
          </Button>
        </div>
      </div>

      {lastScanAt ? (
        <div className="mb-3 rounded-2xl border border-[var(--line)] bg-[var(--app-bg)] px-3 py-2 text-xs text-[var(--text-muted)]">
          آخر مسح:{' '}
          {new Intl.DateTimeFormat('ar-PS', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZone: 'Asia/Hebron',
          }).format(lastScanAt)}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto rounded-[24px] border border-[var(--line)] bg-[var(--app-bg)] p-3">
          <div className="space-y-2">
            {invoiceItems.length ? (
              invoiceItems.map((item) => {
                const lineTotal = item.lineTotal ?? item.price * item.qty
                const lockQuantity = Boolean(item.is_weighted || item.is_manual_price)

                return (
                  <Card
                    key={item.lineId}
                    className={`rounded-[20px] border-[var(--line)] bg-white p-3 shadow-none ${selectedLineId === item.lineId ? 'ring-2 ring-orange-200' : ''}`}
                    onClick={() => setSelectedLineId(item.lineId)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold">{item.name}</div>
                        <div className="mt-1 text-xs text-[var(--text-muted)]">
                          {formatQuantity(item.qty)} {item.unit || ''} × {formatMoneyWithCurrency(item.price)} = {formatMoneyWithCurrency(lineTotal)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {lockQuantity ? null : (
                          <Button type="button" size="icon" variant="secondary" className="rounded-xl" onClick={() => changeQty(item.lineId, -1)}>
                            <Minus className="h-4 w-4" />
                          </Button>
                        )}
                        <div className="min-w-8 text-center text-sm font-black">{formatQuantity(item.qty)}</div>
                        {lockQuantity ? null : (
                          <Button type="button" size="icon" variant="secondary" className="rounded-xl" onClick={() => changeQty(item.lineId, 1)}>
                            <Plus className="h-4 w-4" />
                          </Button>
                        )}
                        <Button type="button" size="icon" variant="ghost" className="rounded-xl" onClick={() => removeItem(item.lineId)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                )
              })
            ) : (
              <Card className="flex min-h-full items-center justify-center rounded-[22px] border-dashed bg-white/70 p-6 text-center text-sm text-[var(--text-muted)] shadow-none">
                ابدأ بمسح منتج أو الضغط على أحد المنتجات.
              </Card>
            )}
          </div>
        </div>

        <div className="flex min-h-0 w-[150px] shrink-0 flex-col gap-3 overflow-y-auto rounded-[24px] border border-[var(--line)] bg-[var(--app-bg)] p-3">
          <Card className="rounded-[20px] border-[var(--line)] bg-white p-3 shadow-none">
            <div className="text-xs text-[var(--text-muted)]">المجموع</div>
            <div className="mt-1 text-lg font-black">{subtotal.toFixed(2)}</div>
          </Card>
          <Card className="rounded-[20px] border-[var(--line)] bg-white p-3 shadow-none">
            <div className="text-xs text-[var(--text-muted)]">الإجمالي</div>
            <div className="mt-1 text-lg font-black">{total.toFixed(2)}</div>
          </Card>
          <Button
            type="button"
            variant="secondary"
            className="rounded-2xl"
            onClick={() => {
              setDiscountValue(String(discount || ''))
              setDiscountDialogOpen(true)
            }}
          >
            خصم
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="rounded-2xl"
            onClick={() => {
              setHoldCustomerName(customerName)
              setHoldNameDialogOpen(true)
            }}
          >
            تعليق
          </Button>
          <Button type="button" variant="secondary" className="rounded-2xl" onClick={cancelInvoice}>
            إلغاء
          </Button>
          <Button type="button" className="h-11 rounded-[18px] font-black" disabled={!invoiceItems.length || isSubmitting} onClick={openCheckoutDialog}>
            إتمام البيع
          </Button>
        </div>
      </div>

      <Dialog open={discountDialogOpen} onClose={() => setDiscountDialogOpen(false)}>
        <div className="space-y-4">
          <div className="text-center">
            <div className="text-2xl font-black">إضافة خصم</div>
            <div className="mt-2 text-sm text-[var(--text-muted)]">أدخل قيمة الخصم الحالية على الفاتورة.</div>
          </div>
          <Input value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} />
          <div className="flex gap-3">
            <Button
              type="button"
              className="flex-1"
              onClick={() => {
                const parsed = Number(discountValue || 0)
                setDiscount(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0)
                setDiscountDialogOpen(false)
              }}
            >
              تطبيق الخصم
            </Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setDiscountDialogOpen(false)}>
              إلغاء
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={holdNameDialogOpen} onClose={() => setHoldNameDialogOpen(false)}>
        <div className="space-y-4">
          <div className="text-center">
            <div className="text-2xl font-black">اسم العميل للفاتورة المعلقة</div>
            <div className="mt-2 text-sm text-[var(--text-muted)]">أدخل اسمًا واضحًا حتى يمكن الرجوع لهذه الفاتورة بسهولة لاحقًا.</div>
          </div>
          <Input
            autoFocus
            placeholder="اسم العميل"
            value={holdCustomerName}
            onChange={(event) => setHoldCustomerName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              const cleanName = holdCustomerName.trim()
              if (!cleanName) {
                publishNotice('يرجى إدخال اسم العميل قبل تعليق الفاتورة.', 'error')
                return
              }
              holdInvoice(cleanName)
              setHoldNameDialogOpen(false)
            }}
          />
          <div className="flex gap-3">
            <Button
              type="button"
              className="flex-1"
              onClick={() => {
                const cleanName = holdCustomerName.trim()
                if (!cleanName) {
                  publishNotice('يرجى إدخال اسم العميل قبل تعليق الفاتورة.', 'error')
                  return
                }
                holdInvoice(cleanName)
                setHoldNameDialogOpen(false)
              }}
            >
              تعليق الفاتورة
            </Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setHoldNameDialogOpen(false)}>
              إلغاء
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={heldDialogOpen} onClose={() => setHeldDialogOpen(false)} className="max-w-2xl">
        <div className="space-y-4">
          <div className="text-center">
            <div className="text-2xl font-black">الفواتير المعلقة</div>
            <div className="mt-2 text-sm text-[var(--text-muted)]">اختر فاتورة معلقة لاستئنافها داخل شاشة الكاشير الحالية.</div>
          </div>
          {heldInvoices.length ? (
            <div className="grid max-h-[420px] gap-3 overflow-y-auto pr-1">
              {heldInvoices.map((invoice) => (
                <div key={invoice.id} className="flex items-center justify-between gap-4 rounded-[22px] border border-[var(--line)] bg-[var(--muted)] px-4 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="font-black">#{String(invoice.id).slice(-4)} {invoice.customerName ? `• ${invoice.customerName}` : '• بدون اسم عميل'}</div>
                    <div className="mt-1 text-xs text-[var(--text-muted)]">
                      {invoice.items.length} صنف •{' '}
                      {new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hebron' }).format(new Date(invoice.heldAt))}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      restoreHeldInvoice(invoice.id)
                      setHeldDialogOpen(false)
                    }}
                  >
                    استئناف
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <Card className="rounded-[22px] border-dashed bg-[var(--muted)]/50 p-6 text-center text-sm text-[var(--text-muted)] shadow-none">
              لا توجد فواتير معلقة حاليًا.
            </Card>
          )}
        </div>
      </Dialog>

      <Dialog open={queueDialogOpen} onClose={() => setQueueDialogOpen(false)} className="max-w-3xl">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-2xl font-black">الفواتير المؤجلة</div>
              <div className="mt-2 text-sm text-[var(--text-muted)]">
                راجع الفواتير التي أضيفت أثناء الأوفلاين، مع حالة كل فاتورة وسبب الفشل إن وجد.
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={syncState === 'syncing' || !pendingInvoices.length}
              onClick={() => {
                void syncPendingInvoices().then((result) => {
                  if (result.synced) {
                    publishNotice(`تمت مزامنة ${result.synced} فاتورة مؤجلة.`, 'success')
                    return
                  }
                  if (result.failed) {
                    publishNotice('تعذر مزامنة بعض الفواتير المؤجلة.', 'error')
                  }
                })
              }}
            >
              {syncState === 'syncing' ? 'جارٍ المزامنة...' : 'مزامنة الكل'}
            </Button>
          </div>

          {pendingInvoices.length ? (
            <div className="grid max-h-[440px] gap-3 overflow-y-auto pr-1">
              {pendingInvoices.map((invoice) => {
                const detailsOpen = expandedPendingInvoiceId === invoice.localId
                const lines = getPendingInvoiceLines(invoice)

                return (
                  <Card key={invoice.localId} className="rounded-[22px] border-[var(--line)] p-4 shadow-none">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="font-black">
                          {invoice.summary.customerName || 'بدون اسم عميل'} • {formatMoneyWithCurrency(invoice.summary.total)}
                        </div>
                        <div className="mt-1 text-xs text-[var(--text-muted)]">
                          {invoice.summary.totalQty} صنف • {paymentMethodText(invoice.summary.paymentMethod)} •{' '}
                          {new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hebron' }).format(new Date(invoice.createdAt))}
                        </div>
                        <div className="mt-1 text-xs text-[var(--text-muted)]">عدد محاولات المزامنة: {invoice.retryCount}</div>
                        {invoice.summary.customerPhone ? (
                          <div className="mt-1 text-xs text-[var(--text-muted)]">الهاتف: {invoice.summary.customerPhone}</div>
                        ) : null}
                        {invoice.lastError ? (
                          <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">
                            سبب آخر فشل: {invoice.lastError}
                          </div>
                        ) : null}
                      </div>
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-black ${
                          invoice.status === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : invoice.status === 'syncing'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {invoice.status === 'failed' ? 'فشل' : invoice.status === 'syncing' ? 'تتم المزامنة' : 'بانتظار'}
                      </span>
                    </div>

                    <div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--muted)]/40 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-bold">تفاصيل الفاتورة</div>
                          <div className="mt-1 text-xs text-[var(--text-muted)]">{lines.length} بند محفوظ داخل هذه الفاتورة المؤجلة.</div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          className="rounded-xl"
                          onClick={() => setExpandedPendingInvoiceId((current) => (current === invoice.localId ? null : invoice.localId))}
                        >
                          {detailsOpen ? 'إخفاء التفاصيل' : 'عرض التفاصيل'}
                        </Button>
                      </div>

                      {detailsOpen ? (
                        <div className="mt-3 space-y-2">
                          {lines.map((line) => (
                            <div key={line.key} className="rounded-2xl border border-[var(--line)] bg-white px-3 py-3">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-bold">{line.name}</div>
                                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                                    {formatQuantity(line.quantity)} {line.unit || ''} × {formatMoneyWithCurrency(line.price)}
                                  </div>
                                </div>
                                <div className="text-sm font-black text-[var(--brand)]">{formatMoneyWithCurrency(line.lineTotal)}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={syncState === 'syncing' || invoice.status === 'syncing'}
                        onClick={() => {
                          void syncPendingInvoice(invoice.localId).then((result) => {
                            if (result.synced) {
                              publishNotice('تمت مزامنة الفاتورة المؤجلة بنجاح.', 'success')
                              return
                            }
                            if (result.failed) {
                              publishNotice('تعذر مزامنة هذه الفاتورة الآن.', 'error')
                            }
                          })
                        }}
                      >
                        {invoice.status === 'failed' ? 'إعادة المحاولة' : 'مزامنة الآن'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="text-red-600 hover:bg-red-50 hover:text-red-700"
                        disabled={syncState === 'syncing' || invoice.status === 'syncing'}
                        onClick={() => {
                          void removePendingInvoice(invoice.localId).then((removed) => {
                            if (removed) {
                              publishNotice('تم حذف الفاتورة المؤجلة.', 'success')
                            }
                          })
                        }}
                      >
                        حذف
                      </Button>
                    </div>
                  </Card>
                )
              })}
            </div>
          ) : (
            <Card className="rounded-[22px] border-dashed bg-[var(--muted)]/50 p-6 text-center text-sm text-[var(--text-muted)] shadow-none">
              لا توجد فواتير مؤجلة حاليًا.
            </Card>
          )}
        </div>
      </Dialog>
    </aside>
  )
}
