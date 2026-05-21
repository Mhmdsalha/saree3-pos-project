import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, QrCode, Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCashier, paymentMethodLabel } from '@/features/cashier/cashier-context'
import { printInvoice } from '@/features/cashier/print-invoice'
import { apiRequest } from '@/lib/api-client'
import { formatMoneyWithCurrency } from '@/lib/storefront'
import type { CustomerLookup } from '@/types/api'

function CustomerSuggestions({
  open,
  loading,
  suggestions,
  activeIndex,
  onSelect,
}: {
  open: boolean
  loading: boolean
  suggestions: CustomerLookup[]
  activeIndex: number
  onSelect: (customer: CustomerLookup) => void
}) {
  if (!open) return null

  return (
    <div className="absolute inset-x-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-[22px] border border-[var(--line)] bg-white shadow-[var(--soft-shadow)]">
      {loading ? (
        <div className="px-4 py-3 text-sm text-[var(--text-muted)]">جاري البحث عن العملاء...</div>
      ) : suggestions.length ? (
        <div className="max-h-64 overflow-y-auto py-2">
          {suggestions.map((customer, index) => (
            <button
              key={`${customer.id}-${customer.phone_number}`}
              type="button"
              className={`flex w-full flex-col items-stretch gap-2 px-4 py-3 text-right transition ${
                index === activeIndex ? 'bg-[var(--muted)]' : 'hover:bg-[var(--muted)]/70'
              }`}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(customer)
              }}
            >
              <div className="flex items-start gap-2">
                {customer.telegram_activation_status === 'activated' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : null}
                <div className="break-words text-sm font-bold leading-6">{customer.customer_name || 'بدون اسم'}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-[var(--text-muted)]">{customer.phone_number}</div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="px-4 py-3 text-sm text-[var(--text-muted)]">لا يوجد عميل محفوظ بهذا الاسم.</div>
      )}
    </div>
  )
}

export function CheckoutDialog() {
  const {
    checkoutDialogOpen,
    checkoutState,
    connectionState,
    lastInvoice,
    lastQueuedInvoice,
    closeCheckoutDialog,
    submitCheckout,
    isSubmitting,
    pendingSyncCount,
    total,
    newInvoice,
    customerName,
    customerPhone,
    customerTelegram,
    telegramStatusLoading,
    mobileReady,
    setCustomerName,
    setCustomerPhone,
    sendTelegramActivationToMobile,
    sendInvoicePdfToTelegram,
    isSendingTelegramActivation,
    isSendingInvoicePdf,
  } = useCashier()

  const [suggestions, setSuggestions] = useState<CustomerLookup[]>([])
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [selectedCustomerLabel, setSelectedCustomerLabel] = useState<string | null>(null)
  const blurTimerRef = useRef<number | null>(null)
  const customerNameInputRef = useRef<HTMLInputElement | null>(null)

  const normalizedCustomerName = useMemo(() => customerName.trim(), [customerName])

  useEffect(() => {
    if (!checkoutDialogOpen || checkoutState === 'success') {
      setSuggestions([])
      setSuggestionsOpen(false)
      setSuggestionsLoading(false)
      setActiveIndex(-1)
      return
    }

    if (!normalizedCustomerName || normalizedCustomerName === selectedCustomerLabel) {
      setSuggestions([])
      setSuggestionsOpen(false)
      setSuggestionsLoading(false)
      setActiveIndex(-1)
      return
    }

    const timer = window.setTimeout(async () => {
      try {
        setSuggestionsLoading(true)
        const result = await apiRequest<CustomerLookup[]>(
          `/customers/search?q=${encodeURIComponent(normalizedCustomerName)}&limit=8`,
        )
        setSuggestions(result)
        setSuggestionsOpen(Boolean(result.length))
        setActiveIndex(result.length ? 0 : -1)
      } catch {
        setSuggestions([])
        setSuggestionsOpen(false)
        setActiveIndex(-1)
      } finally {
        setSuggestionsLoading(false)
      }
    }, 220)

    return () => window.clearTimeout(timer)
  }, [checkoutDialogOpen, checkoutState, normalizedCustomerName, selectedCustomerLabel])

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) {
        window.clearTimeout(blurTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const focusCustomerName = () => {
      if (!checkoutDialogOpen || checkoutState === 'success') return
      customerNameInputRef.current?.focus()
      customerNameInputRef.current?.select()
    }
    const triggerTelegram = () => {
      if (!checkoutDialogOpen || checkoutState === 'success') return
      if (!customerPhone.trim() || !mobileReady || isSendingTelegramActivation) return
      void sendTelegramActivationToMobile()
    }

    window.addEventListener('flowpos:focus-customer-name', focusCustomerName)
    window.addEventListener('flowpos:telegram-action', triggerTelegram)
    return () => {
      window.removeEventListener('flowpos:focus-customer-name', focusCustomerName)
      window.removeEventListener('flowpos:telegram-action', triggerTelegram)
    }
  }, [
    checkoutDialogOpen,
    checkoutState,
    customerPhone,
    isSendingTelegramActivation,
    mobileReady,
    sendTelegramActivationToMobile,
  ])

  const selectCustomer = (customer: CustomerLookup) => {
    const name = customer.customer_name || ''
    setCustomerName(name)
    setCustomerPhone(customer.phone_number || '')
    setSelectedCustomerLabel(name.trim() || null)
    setSuggestionsOpen(false)
    setSuggestions([])
    setActiveIndex(-1)
  }

  return (
    <Dialog open={checkoutDialogOpen} onClose={isSubmitting ? () => undefined : closeCheckoutDialog}>
      {checkoutState === 'queued' && lastQueuedInvoice ? (
        <div className="space-y-5 text-center">
          <div className="text-3xl font-black">تم حفظ الفاتورة محليًا</div>
          <div className="text-sm text-[var(--text-muted)]">
            الفاتورة محفوظة بانتظار عودة الاتصال ومزامنتها مع السيرفر.
          </div>
          <Card className="rounded-[24px] border-amber-200 bg-amber-50 p-4 text-right shadow-none">
            <div className="text-sm font-bold text-amber-800">مرجع المزامنة المحلي</div>
            <div className="mt-1 font-mono text-sm">{lastQueuedInvoice.offlineUuid}</div>
            <div className="mt-3 text-xs text-amber-700">
              {pendingSyncCount ? `عدد الفواتير بانتظار المزامنة الآن: ${pendingSyncCount}` : 'ستتم إعادة المحاولة تلقائيًا عند عودة الاتصال.'}
            </div>
          </Card>
          <div className="flex gap-3">
            <Button
              type="button"
              className="flex-1"
              onClick={() => {
                closeCheckoutDialog()
                newInvoice()
              }}
            >
              فاتورة جديدة
            </Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={closeCheckoutDialog}>
              إغلاق
            </Button>
          </div>
        </div>
      ) : checkoutState === 'success' && lastInvoice ? (
        <div className="space-y-5 text-center">
          <div className="text-3xl font-black">تم إتمام البيع بنجاح</div>
          <div className="text-sm text-[var(--text-muted)]">
            فاتورة رقم #{lastInvoice.id} • الإجمالي {formatMoneyWithCurrency(Number(lastInvoice.final_total || total))}
          </div>
          <div className="text-sm text-[var(--text-muted)]">طريقة الدفع: {paymentMethodLabel(lastInvoice.payment_method)}</div>

          <Card className="rounded-[24px] border-[var(--line)] bg-[var(--muted)]/55 p-4 text-right shadow-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-[var(--text-muted)]">إرسال الفاتورة عبر تيليجرام</div>
                <div className="mt-1 text-sm font-black">
                  {customerTelegram?.telegram_status_label || 'غير مفعل على تيليجرام'}
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={isSendingInvoicePdf || connectionState !== 'online'}
                onClick={() => void sendInvoicePdfToTelegram(lastInvoice.id)}
              >
                <Send className="h-4 w-4" />
                {isSendingInvoicePdf ? 'جارٍ الإرسال...' : 'إرسال الفاتورة PDF'}
              </Button>
            </div>
            <div className="mt-2 text-xs text-[var(--text-muted)]">
              إذا لم يكن العميل مفعلًا بعد، سيظهر السبب مباشرة في رسالة تنبيه أسفل الشاشة.
            </div>
          </Card>

          <div className="flex gap-3">
            <Button
              type="button"
              className="flex-1"
              onClick={() => {
                closeCheckoutDialog()
                newInvoice()
              }}
            >
              فاتورة جديدة
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={async () => {
                await printInvoice(lastInvoice.id, lastInvoice.cashier_name || '')
                closeCheckoutDialog()
                newInvoice()
              }}
            >
              طباعة
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="text-center">
            <div className="text-3xl font-black">اختيار طريقة الدفع</div>
            <div className="mt-2 text-sm text-[var(--text-muted)]">
              أدخل بيانات العميل إن وجدت، ويمكنك تفعيل تيليجرام من هنا قبل حفظ الفاتورة.
            </div>
          </div>

          <Card className="rounded-[24px] border-[var(--line)] bg-[var(--muted)]/55 p-4 shadow-none">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="relative">
                <Input
                  ref={customerNameInputRef}
                  placeholder="اسم العميل"
                  value={customerName}
                  onFocus={() => {
                    if (suggestions.length && normalizedCustomerName && normalizedCustomerName !== selectedCustomerLabel) {
                      setSuggestionsOpen(true)
                    }
                  }}
                  onBlur={() => {
                    blurTimerRef.current = window.setTimeout(() => setSuggestionsOpen(false), 120)
                  }}
                  onKeyDown={(event) => {
                    if (!suggestionsOpen || !suggestions.length) return
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setActiveIndex((current) => (current + 1) % suggestions.length)
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setActiveIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1))
                    } else if (event.key === 'Enter') {
                      event.preventDefault()
                      const candidate = suggestions[activeIndex] || suggestions[0]
                      if (candidate) selectCustomer(candidate)
                    } else if (event.key === 'Escape') {
                      setSuggestionsOpen(false)
                    }
                  }}
                  onChange={(event) => {
                    const value = event.target.value
                    setCustomerName(value)
                    if ((selectedCustomerLabel || '') !== value.trim()) {
                      setSelectedCustomerLabel(null)
                    }
                  }}
                />
                <CustomerSuggestions
                  open={suggestionsOpen || suggestionsLoading}
                  loading={suggestionsLoading}
                  suggestions={suggestions}
                  activeIndex={activeIndex}
                  onSelect={selectCustomer}
                />
              </div>

              <Input
                placeholder="جوال العميل"
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value)}
              />
            </div>

            <div className="mt-3 rounded-[18px] border border-[var(--line)] bg-white px-4 py-3">
              <div className="text-xs font-bold text-[var(--text-muted)]">حالة تيليجرام</div>
              <div className="mt-1 text-sm font-black">
                {telegramStatusLoading
                  ? 'جارٍ التحقق...'
                  : customerPhone.trim()
                    ? customerTelegram?.telegram_status_label || 'غير مفعل على تيليجرام'
                    : 'أدخل رقم الهاتف'}
              </div>
            </div>

            <div className="mt-3">
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={!customerPhone.trim() || !mobileReady || isSendingTelegramActivation || connectionState !== 'online'}
                onClick={() => void sendTelegramActivationToMobile()}
              >
                <QrCode className="h-4 w-4" />
                {isSendingTelegramActivation ? 'جارٍ الإرسال...' : 'فتح التفعيل على الموبايل'}
              </Button>
            </div>

            <div className="mt-2 text-xs text-[var(--text-muted)]">
              سيظهر زر إرسال الفاتورة PDF بعد اختيار طريقة الدفع وحفظ الفاتورة.
            </div>
          </Card>

          <div className="grid grid-cols-3 gap-3">
            <Button type="button" disabled={isSubmitting} onClick={() => submitCheckout('cash')}>
              نقدي
            </Button>
            <Button type="button" disabled={isSubmitting} onClick={() => submitCheckout('card')}>
              بطاقة
            </Button>
            <Button type="button" disabled={isSubmitting} onClick={() => submitCheckout('digital')}>
              رقمي
            </Button>
          </div>

          <Button type="button" variant="secondary" className="w-full" onClick={closeCheckoutDialog} disabled={isSubmitting}>
            إلغاء
          </Button>
        </div>
      )}
    </Dialog>
  )
}
