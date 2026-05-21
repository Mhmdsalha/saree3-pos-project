import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiRequest, resolveApiOrigin } from '@/lib/api-client'
import { getStoredSessionSnapshot, getStoredUser } from '@/lib/auth'
import { createOfflineInvoiceUuid, type OfflineInvoiceRecord } from '@/lib/offline-db'
import {
  loadDraftInvoice,
  loadHeldInvoices,
  loadHeldStorageMeta,
  migrateCashierStorageKeys,
  nextLineId,
  normalizeInvoiceItems,
  saveHeldInvoices,
  scopedCashierStorageKeys,
} from '@/features/cashier/cashier-storage'
import {
  paymentMethodLabel,
  type CashierConnectionState,
  type CashierDraftStorage,
  type CashierSyncState,
  type HeldInvoice,
  type InvoiceItem,
  type PaymentMethod,
} from '@/features/cashier/cashier-types'
import { useCashierSocket } from '@/features/cashier/use-cashier-socket'
import { useOfflineInvoiceQueue } from '@/features/cashier/use-offline-invoice-queue'
import { publishNotice } from '@/lib/notice-center'
import { ensureScanSoundUnlocked, playAcceptedScanSound } from '@/lib/scan-sound'
import type { CustomerTelegramStatus, InvoiceCreatePayload, InvoiceOut, Product } from '@/types/api'

type CashierContextValue = {
  invoiceItems: InvoiceItem[]
  selectedLineId: number | null
  payment: PaymentMethod
  discount: number
  customerName: string
  customerPhone: string
  heldInvoices: HeldInvoice[]
  checkoutDialogOpen: boolean
  checkoutState: 'idle' | 'success' | 'queued'
  lastInvoice: InvoiceOut | null
  lastQueuedInvoice: OfflineInvoiceRecord | null
  mobileReady: boolean
  lastScanAt: Date | null
  qrDialogOpen: boolean
  qrUrl: string
  customerTelegram: CustomerTelegramStatus | null
  telegramStatusLoading: boolean
  connectionState: CashierConnectionState
  syncState: CashierSyncState
  pendingSyncCount: number
  failedSyncCount: number
  lastSyncError: string | null
  pendingInvoices: OfflineInvoiceRecord[]
  pendingStockDeltas: Map<number, number>
  addProduct: (product: Product, qty?: number, priceOverride?: number, lineTotalOverride?: number) => void
  addByBarcode: (barcode: string, products: Product[]) => boolean
  changeQty: (lineId: number, delta: number) => void
  removeItem: (lineId: number) => void
  setSelectedLineId: (lineId: number | null) => void
  setCustomerName: (value: string) => void
  setCustomerPhone: (value: string) => void
  setDiscount: (value: number) => void
  setPayment: (value: PaymentMethod) => void
  newInvoice: () => void
  startFreshInvoice: () => void
  holdInvoice: (customerNameOverride?: string) => void
  restoreHeldInvoice: (id: number) => void
  cancelInvoice: () => void
  openCheckoutDialog: () => void
  submitCheckout: (paymentOverride?: PaymentMethod) => Promise<void>
  syncPendingInvoices: () => Promise<{ synced: number; failed: number }>
  syncPendingInvoice: (localId: string) => Promise<{ synced: number; failed: number }>
  removePendingInvoice: (localId: string) => Promise<boolean>
  closeCheckoutDialog: () => void
  openQrDialog: () => Promise<void>
  closeQrDialog: () => void
  sendTelegramActivationToMobile: () => Promise<void>
  sendInvoicePdfToTelegram: (invoiceId: number) => Promise<void>
  isSendingTelegramActivation: boolean
  isSendingInvoicePdf: boolean
  isSubmitting: boolean
  subtotal: number
  total: number
  totalQty: number
}

const CashierContext = createContext<CashierContextValue | null>(null)


export function CashierProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient()
  const storageKeys = useMemo(() => scopedCashierStorageKeys(), [])
  const storedSession = getStoredUser()
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([])
  const [selectedLineId, setSelectedLineId] = useState<number | null>(null)
  const [payment, setPayment] = useState<PaymentMethod>('cash')
  const [discount, setDiscount] = useState(0)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [heldInvoices, setHeldInvoices] = useState<HeldInvoice[]>([])
  const [checkoutDialogOpen, setCheckoutDialogOpen] = useState(false)
  const [checkoutState, setCheckoutState] = useState<'idle' | 'success' | 'queued'>('idle')
  const [lastInvoice, setLastInvoice] = useState<InvoiceOut | null>(null)
  const [lastQueuedInvoice, setLastQueuedInvoice] = useState<OfflineInvoiceRecord | null>(null)
  const [lastScanAt, setLastScanAt] = useState<Date | null>(null)
  const [qrDialogOpen, setQrDialogOpen] = useState(false)
  const [qrUrl, setQrUrl] = useState('')
  const [customerTelegram, setCustomerTelegram] = useState<CustomerTelegramStatus | null>(null)
  const [telegramStatusLoading, setTelegramStatusLoading] = useState(false)
  const mobileReadyAnnouncedRef = useRef<boolean | null>(null)
  const telegramLookupTimerRef = useRef<number | null>(null)
  const telegramPollTimerRef = useRef<number | null>(null)
  const draftPersistTimerRef = useRef<number | null>(null)
  const customerPhoneRef = useRef('')
  const storageSourceIdRef = useRef(
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `cashier-tab-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  const lastSyncStateRef = useRef<CashierSyncState>('idle')

  const {
    connectionState,
    syncState,
    pendingInvoices,
    pendingCount: pendingSyncCount,
    failedCount: failedSyncCount,
    lastSyncError,
    estimatedStockDeltas,
    queueInvoice,
    syncPendingInvoices: syncPendingInvoicesInternal,
    syncPendingInvoice: syncPendingInvoiceInternal,
    removePendingInvoice: removePendingInvoiceInternal,
    markOffline,
    isLikelyNetworkError,
  } = useOfflineInvoiceQueue(storedSession)

  const applyDraftState = useCallback(
    (
      draft: CashierDraftStorage | null,
    ) => {
      if (!draft) {
        setInvoiceItems([])
        setSelectedLineId(null)
        setPayment('cash')
        setDiscount(0)
        setCustomerName('')
        setCustomerPhone('')
        setCustomerTelegram(null)
        return
      }

      const nextItems = normalizeInvoiceItems(draft.invoice?.items)
      setInvoiceItems(nextItems)
      setSelectedLineId(null)
      setPayment(draft.invoice?.payment || 'cash')
      setDiscount(typeof draft.invoice?.discount === 'number' ? draft.invoice.discount : 0)
      setCustomerName(draft.customerName || '')
      setCustomerPhone(draft.customerPhone || '')
      setCustomerTelegram(null)
    },
    [],
  )

  useEffect(() => {
    const unlock = () => {
      void ensureScanSoundUnlocked()
    }

    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('touchstart', unlock, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('touchstart', unlock)
    }
  }, [])

  useEffect(() => {
    migrateCashierStorageKeys(storageKeys)
    setHeldInvoices(loadHeldInvoices(storageKeys.held))
    applyDraftState(loadDraftInvoice(storageKeys.draft))
  }, [applyDraftState, storageKeys])

  useEffect(() => {
    const syncFromStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) return
      if (event.key === storageKeys.held) {
        setHeldInvoices(loadHeldInvoices(storageKeys.held))
        const meta = loadHeldStorageMeta(storageKeys.held)
        if (meta?.sourceId && meta.sourceId !== storageSourceIdRef.current) {
          publishNotice('تم تحديث الفواتير المعلقة من تبويب آخر لنفس الجلسة.', 'info')
        }
        return
      }
      if (event.key === storageKeys.draft) {
        const draft = loadDraftInvoice(storageKeys.draft)
        applyDraftState(draft)
        if (draft?._meta?.sourceId && draft._meta.sourceId !== storageSourceIdRef.current) {
          publishNotice('تم تحديث مسودة الفاتورة من تبويب آخر لنفس الجلسة.', 'info')
        }
      }
    }

    window.addEventListener('storage', syncFromStorage)
    return () => window.removeEventListener('storage', syncFromStorage)
  }, [applyDraftState, storageKeys])

  useEffect(() => {
    if (draftPersistTimerRef.current) {
      window.clearTimeout(draftPersistTimerRef.current)
      draftPersistTimerRef.current = null
    }

    const payload = {
      invoice: {
        items: invoiceItems,
        payment,
        discount,
      },
      customerName,
      customerPhone,
      _meta: {
        sourceId: storageSourceIdRef.current,
        updatedAt: new Date().toISOString(),
      },
    }
    draftPersistTimerRef.current = window.setTimeout(() => {
      window.localStorage.setItem(storageKeys.draft, JSON.stringify(payload))
      draftPersistTimerRef.current = null
    }, 180)

    return () => {
      if (draftPersistTimerRef.current) {
        window.clearTimeout(draftPersistTimerRef.current)
        draftPersistTimerRef.current = null
      }
    }
  }, [invoiceItems, payment, discount, customerName, customerPhone, storageKeys])

  const subtotal = useMemo(
    () => invoiceItems.reduce((sum, item) => sum + (item.lineTotal ?? item.price * item.qty), 0),
    [invoiceItems],
  )
  const total = Math.max(0, subtotal - discount)
  const totalQty = invoiceItems.reduce((sum, item) => sum + Number(item.qty || 0), 0)

  useEffect(() => {
    if (lastSyncStateRef.current === syncState) return

    if (syncState === 'success') {
      publishNotice('تمت مزامنة الفواتير المؤجلة بنجاح.', 'success')
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
    } else if (syncState === 'failed' && lastSyncError) {
      publishNotice(lastSyncError, 'warning')
    }

    lastSyncStateRef.current = syncState
  }, [lastSyncError, queryClient, syncState])

  const fetchCustomerTelegramStatus = useCallback(async (phone: string, silent = false) => {
    const cleanPhone = String(phone || '').trim()
    const normalizedPhone = cleanPhone.replace(/\D/g, '')
    if (!normalizedPhone) {
      setCustomerTelegram(null)
      return null
    }
    if (normalizedPhone.length < 7) {
      setCustomerTelegram(null)
      return null
    }
    setTelegramStatusLoading(true)
    try {
      const result = await apiRequest<CustomerTelegramStatus>(`/customers/telegram/status?phone=${encodeURIComponent(cleanPhone)}`)
      setCustomerTelegram(result)
      return result
    } catch (error) {
      if (!silent) {
        publishNotice(error instanceof Error ? error.message : 'تعذر جلب حالة تيليجرام لهذا العميل.', 'error')
      }
      setCustomerTelegram(null)
      return null
    } finally {
      setTelegramStatusLoading(false)
    }
  }, [])

  useEffect(() => {
    customerPhoneRef.current = customerPhone
    if (telegramLookupTimerRef.current) {
      window.clearTimeout(telegramLookupTimerRef.current)
      telegramLookupTimerRef.current = null
    }

    const cleanPhone = customerPhone.trim()
    if (!cleanPhone) {
      setCustomerTelegram(null)
      if (telegramPollTimerRef.current) {
        window.clearInterval(telegramPollTimerRef.current)
        telegramPollTimerRef.current = null
      }
      return
    }

    telegramLookupTimerRef.current = window.setTimeout(() => {
      void fetchCustomerTelegramStatus(cleanPhone)
    }, 450)

    return () => {
      if (telegramLookupTimerRef.current) {
        window.clearTimeout(telegramLookupTimerRef.current)
        telegramLookupTimerRef.current = null
      }
    }
  }, [customerPhone, fetchCustomerTelegramStatus])

  useEffect(() => {
    if (telegramPollTimerRef.current) {
      window.clearInterval(telegramPollTimerRef.current)
      telegramPollTimerRef.current = null
    }
    if (customerTelegram?.telegram_activation_status !== 'pending' || !customerPhone.trim()) {
      return
    }

    telegramPollTimerRef.current = window.setInterval(() => {
      void fetchCustomerTelegramStatus(customerPhoneRef.current || customerPhone, true)
    }, 4_000)

    return () => {
      if (telegramPollTimerRef.current) {
        window.clearInterval(telegramPollTimerRef.current)
        telegramPollTimerRef.current = null
      }
    }
  }, [customerTelegram?.telegram_activation_status, customerPhone, fetchCustomerTelegramStatus])

  const finalizeCheckoutLocally = useCallback(
    (nextPayment: PaymentMethod) => {
      setPayment(nextPayment)
      setInvoiceItems([])
      setSelectedLineId(null)
      setDiscount(0)
      setCustomerName('')
      setCustomerPhone('')
      setCustomerTelegram(null)
      const nextDraft = {
        invoice: {
          items: [],
          payment: nextPayment,
          discount: 0,
        },
        customerName: '',
        customerPhone: '',
      }
      window.localStorage.setItem(storageKeys.draft, JSON.stringify(nextDraft))
    },
    [storageKeys.draft],
  )

  const buildInvoicePayload = useCallback(
    (paymentOverride?: PaymentMethod): InvoiceCreatePayload => ({
      items: invoiceItems.map((item) => ({
        product_id: item.id,
        quantity: item.qty,
        price: item.is_weighted ? Number(item.lineTotal ?? 0) : item.price,
      })),
      payment_method: paymentOverride || payment,
      discount,
      customer_name: customerName.trim() || null,
      customer_phone: customerPhone.trim() || null,
      notes: null,
      is_paid: true,
      offline_uuid: createOfflineInvoiceUuid(),
    }),
    [customerName, customerPhone, discount, invoiceItems, payment],
  )

  const checkoutMutation = useMutation({
    mutationFn: async ({ payload }: { payload: InvoiceCreatePayload }) => {
      return apiRequest<InvoiceOut>('/invoices', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (invoice, variables) => {
      setLastInvoice(invoice)
      setLastQueuedInvoice(null)
      setCheckoutState('success')
      finalizeCheckoutLocally(variables.payload.payment_method)
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
    },
  })

  const activationMutation = useMutation({
    mutationFn: async () => {
      const phone = customerPhone.trim()
      if (!phone) {
        throw new Error('أدخل رقم هاتف العميل أولًا.')
      }
      const sessionToken = getStoredSessionSnapshot()?.sessionToken || ''
      if (!sessionToken) {
        throw new Error('تعذر تحديد جلسة الكاشير الحالية.')
      }
      return apiRequest<CustomerTelegramStatus>('/customers/telegram/activation-request', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: customerName.trim() || null,
          phone_number: phone,
          session_token: sessionToken,
        }),
      })
    },
    onSuccess: (payload) => {
      setCustomerTelegram(payload)
      publishNotice(payload.telegram_status_label, payload.telegram_activation_status === 'activated' ? 'success' : 'info')
      if (payload.activation_url && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'customer_activation_open',
            customer: payload,
          }),
        )
      }
    },
    onError: (error) => {
      publishNotice(error instanceof Error ? error.message : 'تعذر إرسال التفعيل إلى الموبايل.', 'error')
    },
  })

  const sendInvoicePdfMutation = useMutation({
    mutationFn: async (invoiceId: number) => {
      return apiRequest<{ ok: boolean; status: string; sent_at?: string | null }>(`/invoices/${invoiceId}/send-telegram-pdf`, {
        method: 'POST',
      })
    },
    onSuccess: () => {
      publishNotice('تم إرسال الفاتورة PDF إلى تيليجرام بنجاح.', 'success')
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
    },
    onError: (error) => {
      publishNotice(error instanceof Error ? error.message : 'تعذر إرسال الفاتورة عبر تيليجرام.', 'error')
    },
  })

  const addProduct = useCallback((product: Product, qty = 1, priceOverride?: number, lineTotalOverride?: number) => {
    setInvoiceItems((current) => {
      const existing = current.find((item) => item.id === product.id)
      const effectivePrice = Number(priceOverride ?? product.price ?? 0)
      const effectiveLineTotal = Number(lineTotalOverride ?? effectivePrice * qty)
      if (existing) {
        if (existing.is_manual_price) {
          const lineId = nextLineId()
          setSelectedLineId(lineId)
          return [
            ...current,
            {
              lineId,
              id: product.id,
              barcode: product.barcode ?? null,
              name: product.name,
              price: effectivePrice,
              qty,
              lineTotal: effectiveLineTotal,
              unit: product.unit,
              is_weighted: product.is_weighted,
              is_manual_price: true,
            },
          ]
        }
        setSelectedLineId(existing.lineId)
        return current.map((item) => (item.id === product.id ? { ...item, qty: Number((item.qty + qty).toFixed(3)) } : item))
      }
      const lineId = nextLineId()
      setSelectedLineId(lineId)
        return [
          ...current,
          {
            lineId,
            id: product.id,
            barcode: product.barcode ?? null,
            name: product.name,
          price: effectivePrice,
          qty,
          lineTotal: product.is_weighted ? effectiveLineTotal : undefined,
          unit: product.unit,
          is_weighted: product.is_weighted,
          is_manual_price: product.is_weighted,
        },
      ]
    })
  }, [])

  const addByBarcode = useCallback((barcode: string, products: Product[]) => {
    const value = barcode.trim()
    if (!value) return false
    const product = products.find(
      (item) => String(item.barcode ?? '') === value || (item.extra_barcodes || []).some((extra) => String(extra.barcode) === value),
    )
    if (!product) return false
    if (product.is_weighted) return false
    addProduct(product)
    return true
  }, [addProduct])

  const changeQty = (lineId: number, delta: number) => {
    setInvoiceItems((current) => {
      const nextItems = current
        .map((item) => {
          if (item.lineId !== lineId) return item
          if (item.is_weighted || item.is_manual_price) return item
          return { ...item, qty: Number((item.qty + delta).toFixed(3)) }
        })
        .filter((item) => item.qty > 0)
      if (!nextItems.some((item) => item.lineId === lineId)) {
        setSelectedLineId(nextItems.length ? nextItems[nextItems.length - 1].lineId : null)
      } else {
        setSelectedLineId(lineId)
      }
      return nextItems
    })
  }

  const removeItem = (lineId: number) => {
    setInvoiceItems((current) => {
      const nextItems = current.filter((item) => item.lineId !== lineId)
      setSelectedLineId(nextItems.length ? nextItems[nextItems.length - 1].lineId : null)
      return nextItems
    })
  }

  const newInvoice = () => {
    setInvoiceItems([])
    setSelectedLineId(null)
    setPayment('cash')
    setDiscount(0)
    setCustomerName('')
    setCustomerPhone('')
    setCustomerTelegram(null)
    setCheckoutDialogOpen(false)
    setCheckoutState('idle')
    setLastInvoice(null)
    window.localStorage.removeItem(storageKeys.draft)
  }

  const startFreshInvoice = () => {
    if (invoiceItems.length) {
      holdInvoice()
      return
    }
    newInvoice()
  }

  const holdInvoice = (customerNameOverride?: string) => {
    if (!invoiceItems.length) return
    const heldCustomerName = (customerNameOverride ?? customerName).trim()
    const nextHeld: HeldInvoice = {
      id: Date.now(),
      heldAt: new Date().toISOString(),
      customerName: heldCustomerName,
      customerPhone,
      payment,
      discount,
      items: invoiceItems,
    }
    const nextList = [...heldInvoices, nextHeld]
    setHeldInvoices(nextList)
    saveHeldInvoices(storageKeys.held, nextList, storageSourceIdRef.current)
    newInvoice()
    publishNotice('تم تعليق الفاتورة الحالية.', 'info')
  }

  const restoreHeldInvoice = (id: number) => {
    const item = heldInvoices.find((entry) => entry.id === id)
    if (!item) return
    setInvoiceItems(normalizeInvoiceItems(item.items))
    setSelectedLineId(null)
    setCustomerName(item.customerName)
    setCustomerPhone(item.customerPhone)
    setPayment(item.payment)
    setDiscount(item.discount)
    const nextHeld = heldInvoices.filter((entry) => entry.id !== id)
    setHeldInvoices(nextHeld)
    saveHeldInvoices(storageKeys.held, nextHeld, storageSourceIdRef.current)
    publishNotice('تم استئناف الفاتورة المعلقة.', 'success')
  }

  const cancelInvoice = () => {
    newInvoice()
  }

  const submitCheckout = async (paymentOverride?: PaymentMethod) => {
    if (!invoiceItems.length) return

    const payload = buildInvoicePayload(paymentOverride)
    const summary = {
      customerName: payload.customer_name,
      customerPhone: payload.customer_phone,
      paymentMethod: payload.payment_method,
      subtotal,
      discount,
      total,
      totalQty,
      items: invoiceItems.map((item) => ({
        productId: item.id,
        name: item.name || null,
        quantity: item.qty,
        price: item.price,
        lineTotal: item.lineTotal ?? item.price * item.qty,
        unit: item.unit ?? null,
      })),
    }

    const saveOffline = async (notice: string) => {
      const queued = await queueInvoice({ payload, summary })
      setLastQueuedInvoice(queued)
      setLastInvoice(null)
      setCheckoutState('queued')
      finalizeCheckoutLocally(payload.payment_method)
      publishNotice(notice, 'warning')
    }

    if (connectionState === 'offline') {
      void saveOffline('تمت إضافة الفاتورة إلى الفواتير المؤجلة بانتظار المزامنة.')
      return
    }

    try {
      await checkoutMutation.mutateAsync({ payload })
    } catch (error) {
      if (isLikelyNetworkError(error)) {
        markOffline()
        void saveOffline('انقطع الاتصال أثناء الحفظ. تمت إضافة الفاتورة إلى الفواتير المؤجلة.')
        return
      }
      publishNotice(error instanceof Error ? error.message : 'تعذر حفظ الفاتورة.', 'error')
    }
  }

  const generateQrUrl = useCallback(async () => {
    const session = getStoredSessionSnapshot()
    if (!session) return ''

    const qrUrl = (baseOrigin: string) => {
      const params = new URLSearchParams({
        bootstrap: bootstrapToken,
      })
      const scannerUrl = `${baseOrigin}/mobile-react/?${params.toString()}`
      return scannerUrl
    }

    const bootstrap = await apiRequest<{ bootstrap_token: string; expires_at?: string | null }>('/sessions/mobile-bootstrap', {
      method: 'POST',
      body: JSON.stringify({ session_token: session.sessionToken }),
    })
    const bootstrapToken = String(bootstrap.bootstrap_token || '').trim()
    if (!bootstrapToken) {
      throw new Error('تعذر إنشاء رابط ربط الموبايل الآمن.')
    }

    const toOrigin = (value: string) => {
      const clean = value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
      const isIP = /^\d+\.\d+\.\d+\.\d+/.test(clean) || clean.startsWith('localhost')
      return `${isIP ? 'http' : 'https'}://${clean}`
    }

    const manualHost = window.localStorage.getItem('pos_mobile_server') || ''
    const manualOrigin = manualHost.trim() ? toOrigin(manualHost) : ''

    try {
      const local = await apiRequest<{ url: string | null; mobile_url?: string | null; active?: boolean; mode?: string | null; restart_required?: boolean; message?: string | null }>('/local-mobile-url')
      if (local.active === false) {
        throw new Error(local.message || 'رابط الماسح يحتاج تحديث من اللانشر. لا تحتاج تثبيت شهادة جديدة.')
      }
      if (local.active && local.url && String(local.url).startsWith('https://')) {
        const localOrigin = String(local.mobile_url || local.url).replace(/\/mobile-react\/?$/i, '').replace(/\/$/, '')
        return qrUrl(localOrigin)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('رابط الماسح')) {
        throw error
      }
    }

    if (manualOrigin) {
      return qrUrl(manualOrigin)
    }

    try {
      const ip = await apiRequest<{ ip: string }>('/server-ip')
      if (ip.ip && ip.ip !== '127.0.0.1') {
        const apiOrigin = resolveApiOrigin(true)
        const apiUrl = new URL(apiOrigin)
        return qrUrl(`https://${ip.ip}:${apiUrl.port || '8000'}`)
      }
    } catch {
      // ignore
    }

    return qrUrl(resolveApiOrigin(true))
  }, [])

  const handleSocketProductFound = useCallback(
    (product: Product) => {
      if (!product.is_weighted) {
        addProduct(product)
        setLastScanAt(new Date())
        void playAcceptedScanSound()
      }
    },
    [addProduct],
  )

  const handleSocketTelegramStatus = useCallback((nextCustomer: CustomerTelegramStatus) => {
    if (!nextCustomer.phone_number || nextCustomer.phone_number === customerPhoneRef.current.replace(/\D/g, '')) {
      setCustomerTelegram(nextCustomer)
      if (nextCustomer.telegram_activation_status === 'activated') {
        publishNotice('تم تفعيل تيليجرام بنجاح. يمكنك الآن إرسال الفاتورة PDF.', 'success')
      } else if (nextCustomer.telegram_activation_status === 'expired') {
        publishNotice(nextCustomer.telegram_status_label, 'warning')
      } else if (nextCustomer.telegram_activation_status === 'failed') {
        publishNotice(nextCustomer.telegram_status_label, 'error')
      }
    }
  }, [])

  const { mobileReady, wsRef } = useCashierSocket({
    onProductFound: handleSocketProductFound,
    onCustomerTelegramStatus: handleSocketTelegramStatus,
  })

  useEffect(() => {
    return () => {
      if (telegramLookupTimerRef.current) {
        window.clearTimeout(telegramLookupTimerRef.current)
        telegramLookupTimerRef.current = null
      }
      if (telegramPollTimerRef.current) {
        window.clearInterval(telegramPollTimerRef.current)
        telegramPollTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (mobileReadyAnnouncedRef.current === null) {
      mobileReadyAnnouncedRef.current = mobileReady
      return
    }
    if (mobileReadyAnnouncedRef.current !== mobileReady) {
      publishNotice(mobileReady ? 'تم اتصال نظام الموبايل بنجاح.' : 'انقطع اتصال نظام الموبايل.', mobileReady ? 'success' : 'warning')
      mobileReadyAnnouncedRef.current = mobileReady
    }
  }, [mobileReady])

  const value: CashierContextValue = {
    invoiceItems,
    selectedLineId,
    payment,
    discount,
    customerName,
    customerPhone,
    heldInvoices,
    checkoutDialogOpen,
    checkoutState,
    lastInvoice,
    lastQueuedInvoice,
    customerTelegram,
    telegramStatusLoading,
    connectionState,
    syncState,
    pendingSyncCount,
    failedSyncCount,
    lastSyncError,
    pendingInvoices,
    pendingStockDeltas: estimatedStockDeltas,
    addProduct,
    addByBarcode,
    changeQty,
    removeItem,
    setSelectedLineId,
    setCustomerName,
    setCustomerPhone,
    setDiscount,
    setPayment,
    newInvoice,
    startFreshInvoice,
    holdInvoice,
    restoreHeldInvoice,
    cancelInvoice,
    openCheckoutDialog: () => {
      if (!invoiceItems.length) return
      setCheckoutState('idle')
      setLastInvoice(null)
      setLastQueuedInvoice(null)
      setCheckoutDialogOpen(true)
    },
    submitCheckout,
    syncPendingInvoices: async () => syncPendingInvoicesInternal(),
    syncPendingInvoice: async (localId: string) => syncPendingInvoiceInternal(localId),
    removePendingInvoice: async (localId: string) => removePendingInvoiceInternal(localId),
    closeCheckoutDialog: () => {
      setCheckoutDialogOpen(false)
      setCheckoutState('idle')
    },
    openQrDialog: async () => {
      try {
        const nextUrl = await generateQrUrl()
        setQrUrl(nextUrl)
        setQrDialogOpen(true)
      } catch (error) {
        publishNotice(error instanceof Error ? error.message : 'تعذر إنشاء رابط ربط الموبايل الآن.', 'error')
      }
    },
    closeQrDialog: () => setQrDialogOpen(false),
    sendTelegramActivationToMobile: async () => {
      if (!mobileReady) {
        publishNotice('الموبايل غير متصل حاليًا. اربط الموبايل أولًا.', 'error')
        return
      }
      await activationMutation.mutateAsync()
    },
    sendInvoicePdfToTelegram: async (invoiceId: number) => {
      await sendInvoicePdfMutation.mutateAsync(invoiceId)
    },
    isSendingTelegramActivation: activationMutation.isPending,
    isSendingInvoicePdf: sendInvoicePdfMutation.isPending,
    isSubmitting: checkoutMutation.isPending,
    subtotal,
    total,
    totalQty,
    mobileReady,
    lastScanAt,
    qrDialogOpen,
    qrUrl,
  }

  return <CashierContext.Provider value={value}>{children}</CashierContext.Provider>
}

export function useCashier() {
  const context = useContext(CashierContext)
  if (!context) {
    throw new Error('useCashier must be used within CashierProvider')
  }
  return context
}

export { paymentMethodLabel, type PaymentMethod }
