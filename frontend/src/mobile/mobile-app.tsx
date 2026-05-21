import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ToastStack } from '@/components/ui/toast-stack'
import { clearStoredSession, getStoredUser, type StoredSession } from '@/lib/auth'
import { apiGet } from '@/lib/api-client'
import { loadCachedSellableProducts, saveCachedSellableProducts } from '@/lib/offline-db'
import { publishNotice, useNoticeCenter } from '@/lib/notice-center'
import { formatMoneyWithCurrency, primeStorefrontBranding } from '@/lib/storefront'
import { formatHebronShortDateTime } from '@/lib/time'
import {
  clearTimerRef,
} from '@/lib/ws-session'
import {
  buildCameraConstraints,
  formatScannerError,
  isAndroidLike,
  isCameraOverlayPermissionError,
  isIosLike,
  isValidEAN13,
  openPreferredCamera,
  styleQuaggaSurface,
  waitForVideoFrame,
  type CameraSelection,
} from '@/mobile/scanner-utils'
import { InfoTile } from '@/mobile/info-tile'
import { MobileLogin } from '@/mobile/mobile-login'
import {
  clearMobileSessionBackup,
  consumeMobileBootstrap,
  getMobileSessionBackup,
  normalizeOrigin,
  restoreMobileOfflineBridge,
  restoreMobileSession,
} from '@/mobile/session-utils'
import { useMobileSocket } from '@/mobile/use-mobile-socket'
import { useMobileScanQueue } from '@/mobile/use-mobile-scan-queue'
import type { CustomerTelegramStatus, Product } from '@/types/api'

type ScanState = 'idle' | 'requesting_permission' | 'preparing' | 'ready' | 'paused' | 'unsupported'
type ScanNotice = { kind: 'accepted' | 'duplicate'; text: string } | null
type ProductResult =
  | { type: 'found'; product: Product }
  | { type: 'not_found'; barcode: string }
  | null

type CustomerActivationView = {
  customer: CustomerTelegramStatus
  qrImage: string
}

type BarcodeDetectorCtor = {
  getSupportedFormats?: () => Promise<string[]>
  new (options?: { formats?: string[] }): {
    detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string; value?: string }>>
  }
}

type QuaggaModule = {
  init: (config: Record<string, unknown>, cb: (error?: Error | null) => void) => void
  start: () => void
  stop: () => void
  onDetected: (handler: (result: { codeResult?: { code?: string } }) => void) => void
  offDetected?: (handler: (result: { codeResult?: { code?: string } }) => void) => void
}

type ZXingModule = typeof import('@zxing/library')

type BarcodeHandlerOptions = {
  scanStateRef: React.MutableRefObject<ScanState>
  lastAcceptedRef: React.MutableRefObject<{ value: string; at: number } | null>
  onAccepted: (barcode: string) => void
  onDuplicate: (barcode: string) => void
}

type ScannerStartArgs = {
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  quaggaTargetRef: React.MutableRefObject<HTMLDivElement | null>
  streamRef: React.MutableRefObject<MediaStream | null>
  detectorRef: React.MutableRefObject<InstanceType<BarcodeDetectorCtor> | null>
  animationRef: React.MutableRefObject<number | null>
  quaggaRef: React.MutableRefObject<QuaggaModule | null>
  quaggaHandlerRef: React.MutableRefObject<((result: { codeResult?: { code?: string } }) => void) | null>
  html5QrRef: React.MutableRefObject<{ stop: () => Promise<void>; clear: () => void } | null>
  zxingReaderRef: React.MutableRefObject<{ reset?: () => void; stopContinuousDecode?: () => void } | null>
  scanStateRef: React.MutableRefObject<ScanState>
  onDetected: (barcode: string) => void
  cameraSelection?: CameraSelection
  initialStream?: MediaStream | null
}

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor
  }
}

const SAME_BARCODE_COOLDOWN_MS = 1_500
const POST_SCAN_PAUSE_MS = 1_800
const NATIVE_DETECT_INTERVAL_MS = 140
export function MobileApp() {
  const { notices } = useNoticeCenter()
  const [session, setSession] = useState<StoredSession | null>(null)
  const [hydrating, setHydrating] = useState(true)
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [manualBarcode, setManualBarcode] = useState('')
  const [lastResult, setLastResult] = useState<ProductResult>(null)
  const [lastScanAt, setLastScanAt] = useState<string | null>(null)
  const [scannerEngine, setScannerEngine] = useState('غير مفعل')
  const [scanNotice, setScanNotice] = useState<ScanNotice>(null)
  const [customerActivation, setCustomerActivation] = useState<CustomerActivationView | null>(null)
  const [scannerError, setScannerError] = useState<string>('')
  const [cameraOverlayHelp, setCameraOverlayHelp] = useState(false)
  const [cameraBusy, setCameraBusy] = useState(false)
  const [cachedProducts, setCachedProducts] = useState<Product[]>([])
  const [queuedScansOpen, setQueuedScansOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const quaggaTargetRef = useRef<HTMLDivElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animationRef = useRef<number | null>(null)
  const detectorRef = useRef<InstanceType<BarcodeDetectorCtor> | null>(null)
  const quaggaRef = useRef<QuaggaModule | null>(null)
  const quaggaHandlerRef = useRef<((result: { codeResult?: { code?: string } }) => void) | null>(null)
  const html5QrRef = useRef<{
    stop: () => Promise<void>
    clear: () => void
  } | null>(null)
  const zxingReaderRef = useRef<{
    reset?: () => void
    stopContinuousDecode?: () => void
  } | null>(null)
  const scanStateRef = useRef<ScanState>('idle')
  const lastAcceptedBarcodeRef = useRef<{ value: string; at: number } | null>(null)
  const flushPendingScansRef = useRef<() => void>(() => undefined)
  const acknowledgeScanRef = useRef<(scanId?: string | null) => void>(() => undefined)
  const noticeTimerRef = useRef<number | null>(null)
  const scanResumeTimerRef = useRef<number | null>(null)

  const showNotice = useCallback((kind: 'accepted' | 'duplicate', text: string, duration = 1_000) => {
    setScanNotice({ kind, text })
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current)
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setScanNotice(null)
      noticeTimerRef.current = null
    }, duration)
  }, [])

  useEffect(() => {
    void primeStorefrontBranding()
  }, [])

  useEffect(() => {
    let cancelled = false
    const activationUrl = customerActivation?.customer.activation_url
    if (!activationUrl) {
      if (customerActivation?.qrImage) {
        setCustomerActivation((current) => (current ? { ...current, qrImage: '' } : current))
      }
      return
    }

    QRCode.toDataURL(activationUrl, {
      width: 260,
      margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setCustomerActivation((current) => (current ? { ...current, qrImage: dataUrl } : current))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCustomerActivation((current) => (current ? { ...current, qrImage: '' } : current))
        }
      })

    return () => {
      cancelled = true
    }
  }, [customerActivation?.customer.activation_url])

  useEffect(() => {
    scanStateRef.current = scanState
  }, [scanState])

  useEffect(() => {
    let active = true

    const hydrate = async () => {
      const params = new URLSearchParams(window.location.search)
      const bootstrap = params.get('bootstrap')
      const token = params.get('token')
      const sessionToken = params.get('session')
      const server = params.get('server')

      if (bootstrap) {
        try {
          const restored = await consumeMobileBootstrap(bootstrap, window.location.origin)
          window.history.replaceState({}, document.title, `${window.location.pathname}`)
          if (!active) return
          setSession(restored)
          setHydrating(false)
          return
        } catch (sessionError) {
          if (!active) return
          clearStoredSession()
          clearMobileSessionBackup()
          publishNotice(sessionError instanceof Error ? sessionError.message : 'تعذر استكمال ربط الموبايل الآمن.', 'error')
        }
      }

      if (token && sessionToken && server) {
        try {
          const restored = await restoreMobileSession({
            serverUrl: normalizeOrigin(server),
            token,
            sessionToken,
            user: {} as StoredSession['user'],
          })
          if (!active) return
          setSession(restored)
          setHydrating(false)
          return
        } catch (sessionError) {
          if (!active) return
          clearStoredSession()
          clearMobileSessionBackup()
          publishNotice(sessionError instanceof Error ? sessionError.message : 'تعذر استكمال ربط الموبايل.', 'error')
        }
      }

      try {
        const restored = await restoreMobileSession(getStoredUser() || getMobileSessionBackup())
        if (!active) return
        setSession(restored)
        if (restored) return
        const offlineBridge = await restoreMobileOfflineBridge()
        if (!active) return
        setSession(offlineBridge)
      } catch (sessionError) {
        if (!active) return
        clearStoredSession()
        clearMobileSessionBackup()
        setSession(null)
        publishNotice(sessionError instanceof Error ? sessionError.message : 'انتهت جلسة الموبايل. أعد الربط من الكاشير.', 'error')
      } finally {
        if (active) {
          setHydrating(false)
        }
      }
    }

    void hydrate()
    return () => {
      active = false
    }
  }, [])

  const handleProductFound = useCallback(
    (product: Product, scanId?: string | null) => {
      setLastResult({ type: 'found', product })
      setLastScanAt(new Date().toISOString())
      acknowledgeScanRef.current(scanId)
    },
    [],
  )

  const handleProductNotFound = useCallback((barcode: string, scanId?: string | null) => {
    setLastResult({ type: 'not_found', barcode })
    setLastScanAt(new Date().toISOString())
    acknowledgeScanRef.current(scanId)
  }, [])

  const handleCustomerActivationOpen = useCallback((customer: CustomerTelegramStatus) => {
    setCustomerActivation({ customer, qrImage: '' })
  }, [])

  const handleCustomerTelegramStatus = useCallback((customer: CustomerTelegramStatus) => {
    setCustomerActivation((current) => {
      if (!current) {
        return customer.telegram_activation_status === 'pending' ? { customer, qrImage: '' } : null
      }
      return { customer, qrImage: current.qrImage }
    })
  }, [])

  const handleSessionExpired = useCallback(() => {
    setSession(null)
  }, [])

  const { connection, wsRef, connectNow } = useMobileSocket({
    session,
    flushPendingBarcodes: () => flushPendingScansRef.current(),
    showNotice,
    onProductFound: handleProductFound,
    onProductNotFound: handleProductNotFound,
    onCustomerActivationOpen: handleCustomerActivationOpen,
    onCustomerTelegramStatus: handleCustomerTelegramStatus,
    onScanAcknowledged: (scanId?: string | null) => acknowledgeScanRef.current(scanId),
    onSessionExpired: handleSessionExpired,
  })

  const { pendingScanCount, pendingScans, activeScanId, queueScan, acknowledgeScan, removeQueuedScan, flushPendingScans } = useMobileScanQueue({
    session,
    connection,
    wsRef,
  })

  useEffect(() => {
    flushPendingScansRef.current = () => {
      void flushPendingScans()
    }
  }, [flushPendingScans])

  useEffect(() => {
    acknowledgeScanRef.current = (scanId?: string | null) => {
      void acknowledgeScan(scanId)
    }
  }, [acknowledgeScan])

  useEffect(() => {
    let active = true

    const hydrateProducts = async () => {
      if (!session?.serverUrl) {
        if (active) {
          setCachedProducts([])
        }
        return
      }

      const cached = await loadCachedSellableProducts(session.serverUrl).catch(() => null)
      if (active && cached?.products) {
        setCachedProducts(cached.products)
      }

      try {
        const products = await apiGet<Product[]>('/products?sellable_only=true')
        await saveCachedSellableProducts(session.serverUrl, products)
        if (active) {
          setCachedProducts(products)
        }
      } catch {
        // keep the latest cached copy when offline or unavailable
      }
    }

    void hydrateProducts()
    return () => {
      active = false
    }
  }, [session?.serverUrl, session?.sessionToken])

  const sendBarcode = useCallback(
    (barcode: string) => {
      const value = String(barcode || '').trim()
      if (!isValidEAN13(value)) return

      void queueScan(value).catch((error) => {
        publishNotice(error instanceof Error ? error.message : 'تعذر حفظ السكان محليًا.', 'error')
      })
      if (connection !== 'connected') {
        connectNow()
      }
    },
    [connectNow, connection, queueScan],
  )

  const requestAddProduct = useCallback(
    (barcode: string) => {
      const value = String(barcode || '').trim()
      if (!isValidEAN13(value)) {
        publishNotice('الباركود غير صالح. يجب أن يكون EAN-13.', 'error')
        return
      }
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'add_product_request', barcode: value }))
        showNotice('accepted', 'تم إرسال طلب إضافة المنتج إلى الديسكتوب', 1400)
        navigator.vibrate?.(30)
        return
      }
      publishNotice('تعذر إرسال طلب الإضافة. تأكد من اتصال الموبايل بجلسة الكاشير.', 'error')
    },
    [showNotice],
  )

  useEffect(() => {
    return () => {
      void stopScanner(videoRef, quaggaTargetRef, streamRef, detectorRef, animationRef, quaggaRef, quaggaHandlerRef, html5QrRef, zxingReaderRef)
      clearTimerRef(noticeTimerRef)
      clearTimerRef(scanResumeTimerRef)
    }
  }, [])

  const pauseScanning = useCallback((duration = POST_SCAN_PAUSE_MS) => {
    scanStateRef.current = 'paused'
    setScanState('paused')

    if (scanResumeTimerRef.current) {
      window.clearTimeout(scanResumeTimerRef.current)
    }

    scanResumeTimerRef.current = window.setTimeout(() => {
      scanResumeTimerRef.current = null
      const scannerStillActive = Boolean(
        streamRef.current ||
          detectorRef.current ||
          quaggaRef.current ||
          quaggaHandlerRef.current ||
          zxingReaderRef.current ||
          html5QrRef.current,
      )

      if (scannerStillActive) {
        scanStateRef.current = 'ready'
        setScanState('ready')
      }
    }, duration)
  }, [])

  const powerOffCamera = useCallback(async () => {
    await stopScanner(videoRef, quaggaTargetRef, streamRef, detectorRef, animationRef, quaggaRef, quaggaHandlerRef, html5QrRef, zxingReaderRef)
    if (scanResumeTimerRef.current) {
      window.clearTimeout(scanResumeTimerRef.current)
      scanResumeTimerRef.current = null
    }
    setScanState('idle')
    setScannerEngine('غير مفعل')
    setCameraBusy(false)
    setScannerError('')
    setCameraOverlayHelp(false)
  }, [])

  const requestCamera = useCallback(async (selection?: CameraSelection) => {
    const effectiveSelection = selection ?? ({ facing: 'environment' } satisfies CameraSelection)
    let permissionProbeStream: MediaStream | null = null

    try {
      setCameraBusy(true)
      setLastResult(null)
      setScannerError('')
      setCameraOverlayHelp(false)
      setScanState('requesting_permission')

      // On some Android browsers the permission prompt must happen directly
      // in the original click handler before additional async work starts.
      permissionProbeStream = await openPreferredCamera(effectiveSelection)

      await stopScanner(videoRef, quaggaTargetRef, streamRef, detectorRef, animationRef, quaggaRef, quaggaHandlerRef, html5QrRef, zxingReaderRef)

      const onDetected = createBarcodeHandler({
        scanStateRef,
        lastAcceptedRef: lastAcceptedBarcodeRef,
        onAccepted: (barcode) => {
          pauseScanning()
          showNotice('accepted', 'تم التقاط الباركود')
          sendBarcode(barcode)
        },
        onDuplicate: () => {
          showNotice('duplicate', 'تم تجاهل قراءة مكررة')
        },
      })

      setScanState('preparing')
      const engine = await startScanner({
        videoRef,
        quaggaTargetRef,
        streamRef,
        detectorRef,
        animationRef,
        quaggaRef,
        quaggaHandlerRef,
        html5QrRef,
        zxingReaderRef,
        scanStateRef,
        onDetected,
        cameraSelection: effectiveSelection,
        initialStream: permissionProbeStream,
      })

      setScannerEngine(engine)
      setScanState('ready')
      setScannerError('')
      return true
    } catch (cameraError) {
      setScanState('unsupported')
      setScannerEngine('غير متاح')
      const message = formatScannerError(cameraError)
      setCameraOverlayHelp(isCameraOverlayPermissionError(cameraError) || isCameraOverlayPermissionError(message))
      setScannerError(message)
      publishNotice(message, 'error')
      if (permissionProbeStream) {
        try {
          permissionProbeStream.getTracks().forEach((track) => track.stop())
        } catch {
          // ignore
        }
      }
      return false
    } finally {
      setCameraBusy(false)
    }
  }, [pauseScanning, showNotice, sendBarcode])

  const scannerStatusText = useMemo(() => {
    if (scanState === 'idle') return 'الكاميرا متوقفة'
    if (scanState === 'requesting_permission') return 'بانتظار إذن الكاميرا'
    if (scanState === 'preparing') return 'جارٍ تجهيز الماسح'
    if (scanState === 'ready') return `جاهز للمسح • ${scannerEngine}`
    if (scanState === 'paused') return 'تم تثبيت القراءة لحظة لمنع التكرار'
    if (scanState === 'unsupported') return 'تعذر تشغيل الكاميرا'
    if (connection === 'reconnecting') return 'إعادة الاتصال بجلسة الكاشير'
    if (connection === 'connecting') return 'جارٍ ربط الموبايل بالجلسة'
    return 'جاهز للربط'
  }, [connection, scanState, scannerEngine])

  const queuedScanItems = useMemo(() => {
    return pendingScans.map((scan) => {
      const matchedProduct = cachedProducts.find((product) => {
        if (String(product.barcode || '').trim() === scan.barcode) return true
        return (product.extra_barcodes || []).some((item) => String(item.barcode || '').trim() === scan.barcode)
      })

      return {
        ...scan,
        productName: matchedProduct?.name || null,
        productPrice: matchedProduct?.price ?? null,
      }
    })
  }, [cachedProducts, pendingScans])

  if (hydrating) {
    return (
      <>
        <ToastStack notices={notices} />
        <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] p-6">
          <Card className="w-full max-w-sm p-8 text-center">
            <div className="text-xl font-black">جارٍ تجهيز الماسح...</div>
          </Card>
        </div>
      </>
    )
  }

  if (!session) {
    return (
      <>
        <ToastStack notices={notices} />
        <MobileLogin onLogin={setSession} />
      </>
    )
  }

  return (
    <>
      <ToastStack notices={notices} />
      <div className="min-h-screen bg-[var(--app-bg)] px-4 py-4">
        <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xl font-black">ماسح سريع</div>
              <div className="mt-1 text-sm text-[var(--text-muted)]">{session.user.name}</div>
            </div>
            <div
              className={`rounded-full px-3 py-1 text-xs font-black ${
                connection === 'connected'
                  ? 'bg-emerald-100 text-emerald-700'
                  : connection === 'reconnecting'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-red-100 text-red-700'
              }`}
            >
              {connection === 'connected' ? 'متصل' : connection === 'reconnecting' ? 'يعيد الاتصال' : 'غير متصل'}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
            <span>{scannerStatusText}</span>
            <span>{lastScanAt ? formatHebronShortDateTime(lastScanAt) : 'لا يوجد مسح بعد'}</span>
          </div>
            {connection !== 'connected' ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-amber-200 bg-amber-50 px-4 py-3">
                <div className="text-xs font-semibold text-amber-700">
                  وضع أوفلاين مفعل. سيتم حفظ القراءات محليًا حتى عودة الاتصال.
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-2xl border-amber-200 bg-white px-3 text-xs text-amber-800 hover:bg-amber-100"
                  onClick={() => setQueuedScansOpen(true)}
                >
                  القراءات المؤجلة{pendingScanCount ? ` (${pendingScanCount})` : ''}
                </Button>
              </div>
            ) : null}
            <div className="mt-2 text-xs text-[var(--text-muted)]">
              الكاميرا الحالية: <span className="font-semibold text-[var(--text-strong)]">الكاميرا الخلفية</span>
            </div>
        </Card>

        {customerActivation ? (
          <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 text-center">
                <div className="text-xl font-black">تفعيل استلام الفاتورة عبر تيليجرام</div>
                <div className="mt-2 text-sm text-[var(--text-muted)]">امسح الكود وافتح البوت ثم اضغط Start.</div>
              </div>
              <Button type="button" variant="secondary" className="shrink-0 rounded-2xl px-3" onClick={() => setCustomerActivation(null)}>
                إغلاق
              </Button>
            </div>
            <div className="mt-3 rounded-2xl bg-[var(--muted)] px-3 py-2 text-center text-sm font-semibold text-[var(--text-strong)]">
              {customerActivation.customer.telegram_status_label}
            </div>
            <div className="mt-4 flex justify-center">
              <div className="rounded-[24px] border border-[var(--line)] bg-white p-3">
                {customerActivation.qrImage ? (
                  <img src={customerActivation.qrImage} alt="Telegram activation QR" className="h-[240px] w-[240px] rounded-xl" />
                ) : (
                  <div className="flex h-[240px] w-[240px] items-center justify-center rounded-xl bg-[var(--muted)] text-sm text-[var(--text-muted)]">
                    جارٍ تجهيز رمز التفعيل...
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4 text-center text-sm font-semibold">{customerActivation.customer.customer_name || 'العميل الحالي'}</div>
            <div className="mt-1 text-center text-xs text-[var(--text-muted)]" dir="ltr">{customerActivation.customer.phone_number || '—'}</div>
            {customerActivation.customer.activation_token_expiry ? (
              <div className="mt-3 text-center text-xs text-[var(--text-muted)]">
                ينتهي الطلب: {formatHebronShortDateTime(customerActivation.customer.activation_token_expiry)}
              </div>
            ) : null}
          </Card>
        ) : null}

        <Card className="flex-1 p-4">
          <div className="flex h-full flex-col gap-4">
            {scanState === 'idle' ? (
              <div className="flex h-64 flex-col items-center justify-center rounded-[24px] border border-dashed border-[var(--line)] bg-[var(--muted)] px-5 text-center">
                <div className="text-lg font-black">السكان غير مفعل بعد</div>
                <div className="mt-2 text-sm leading-7 text-[var(--text-muted)]">
                  اسمح للكاميرا أولًا، وبعدها ستدخل مباشرة إلى شاشة المسح وهي جاهزة للعمل.
                </div>
                <Button type="button" className="mt-5 w-full" onClick={() => void requestCamera()}>
                  السماح بالكاميرا وبدء المسح
                </Button>
              </div>
            ) : (
              <div className="relative overflow-hidden rounded-[24px] border border-[var(--line)] bg-slate-950">
                <div ref={quaggaTargetRef} className="absolute inset-0 z-10" />
                <video
                  ref={videoRef}
                  className={`h-64 w-full object-cover ${scannerEngine === 'Quagga2' || scannerEngine === 'HTML5 QRCode' ? 'opacity-0' : 'opacity-100'}`}
                  playsInline
                  muted
                  autoPlay
                />
                <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                  <div className="h-44 w-44 rounded-[28px] border border-white/40 shadow-[0_0_0_999px_rgba(2,6,23,0.1)]" />
                </div>
                {(scanState === 'requesting_permission' || scanState === 'preparing') && (
                  <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/55 text-center text-sm font-bold text-white">
                    {scanState === 'requesting_permission' ? 'بانتظار إذن الكاميرا...' : 'جارٍ تجهيز الماسح...'}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                type="button"
                className="flex-1"
                onClick={scanState === 'idle' ? () => void requestCamera() : () => void powerOffCamera()}
                disabled={cameraBusy}
              >
                {scanState === 'idle' ? 'تشغيل الكاميرا' : 'إيقاف الكاميرا'}
              </Button>
            </div>

            {scanNotice ? (
              <div
                className={`rounded-[22px] border px-4 py-3 text-sm font-semibold ${
                  scanNotice.kind === 'accepted'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-amber-200 bg-amber-50 text-amber-800'
                }`}
              >
                {scanNotice.text}
              </div>
            ) : null}

            {scanState === 'unsupported' ? (
              <div className="rounded-[22px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                تعذر تشغيل محرك المسح على هذا الجهاز. جرّب السماح للكاميرا أو استخدم الإدخال اليدوي مؤقتًا.
              </div>
            ) : null}

            {scannerError ? (
              <div className="rounded-[22px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {scannerError}
              </div>
            ) : null}

            {cameraOverlayHelp ? (
              <div className="rounded-[22px] border border-orange-200 bg-orange-50 px-4 py-4 text-right text-sm leading-7 text-orange-900">
                <div className="font-black">تنبيه لأجهزة شاومي وPOCO</div>
                <p className="mt-2">
                  إذا ظهرت رسالة عن التراكبات أو الفقاعات أثناء السماح للكاميرا، عطّل صلاحية الظهور فوق التطبيقات
                  الأخرى ثم أعد فتح Chrome.
                </p>
                <ol className="mt-3 list-decimal space-y-1 pr-5">
                  <li>افتح إعدادات الهاتف ثم التطبيقات.</li>
                  <li>ادخل إلى الوصول الخاص للتطبيقات.</li>
                  <li>افتح Display over other apps أو الظهور فوق التطبيقات الأخرى.</li>
                  <li>عطّلها مؤقتًا للتطبيقات التي تستخدم فقاعات أو نوافذ عائمة.</li>
                  <li>أغلق Chrome بالكامل وافتح رابط الماسح من جديد.</li>
                </ol>
              </div>
            ) : null}

            <div className="flex gap-2">
              <Input
                value={manualBarcode}
                onChange={(event) => setManualBarcode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    sendBarcode(manualBarcode)
                    setManualBarcode('')
                  }
                }}
                placeholder="إدخال باركود يدوي..."
              />
              <Button
                type="button"
                onClick={() => {
                  sendBarcode(manualBarcode)
                  setManualBarcode('')
                }}
              >
                إرسال
              </Button>
            </div>

            <Card className="flex-1 rounded-[24px] bg-[var(--muted)] p-4 shadow-none">
              {lastResult?.type === 'found' ? (
                <div className="space-y-3">
                  <div className="text-sm font-bold text-emerald-700">تم العثور على المنتج</div>
                  <div className="text-2xl font-black">{lastResult.product.name}</div>
                  <div className="grid grid-cols-2 gap-3">
                    <InfoTile title="السعر" value={formatMoneyWithCurrency(Number(lastResult.product.price || 0))} />
                    <InfoTile title="المخزون" value={String(Number(lastResult.product.stock || 0))} />
                  </div>
                </div>
              ) : lastResult?.type === 'not_found' ? (
                <div className="space-y-3">
                  <div className="text-sm font-bold text-red-700">المنتج غير موجود</div>
                  <div className="font-mono text-lg font-black">{lastResult.barcode}</div>
                  {session.user.role !== 'cashier' ? (
                    <Button type="button" className="w-full" onClick={() => requestAddProduct(lastResult.barcode)}>
                      إضافة المنتج على الديسكتوب
                    </Button>
                  ) : null}
                  <div className="text-sm text-[var(--text-muted)]">سيصل الطلب إلى نفس الديسكتوب المرتبط بهذه الجلسة مباشرة.</div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-center text-sm text-[var(--text-muted)]">
                  وجّه الكاميرا إلى الباركود أو استخدم الإدخال اليدوي، وستظهر آخر نتيجة هنا.
                </div>
              )}
            </Card>
          </div>
        </Card>

        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void stopScanner(videoRef, quaggaTargetRef, streamRef, detectorRef, animationRef, quaggaRef, quaggaHandlerRef, html5QrRef, zxingReaderRef)
            clearStoredSession()
            clearMobileSessionBackup()
            setSession(null)
          }}
        >
          تسجيل الخروج
        </Button>

        <Dialog open={queuedScansOpen} onClose={() => setQueuedScansOpen(false)} className="max-w-md">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-2xl font-black">القراءات المؤجلة</div>
                <div className="mt-2 text-sm text-[var(--text-muted)]">
                  {connection === 'connected'
                    ? 'تتم إعادة الإرسال الآن. يمكنك مراجعة ما تبقى من قراءات مؤجلة.'
                    : 'يمكنك حذف أي قراءة قبل عودة الاتصال إذا لم تعد تريد إرسالها.'}
                </div>
              </div>
              <div className="rounded-full bg-amber-100 px-3 py-1 text-xs font-black text-amber-700">
                {queuedScanItems.length}
              </div>
            </div>

            {queuedScanItems.length ? (
              <div className="grid max-h-[420px] gap-2 overflow-y-auto pr-1">
                {queuedScanItems.map((scan) => {
                  const isSending = scan.scanId === activeScanId || scan.status === 'sending'
                  return (
                    <div
                      key={scan.scanId}
                      className="flex items-center justify-between gap-3 rounded-[20px] border border-[var(--line)] bg-[var(--app-bg)] px-3 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold">
                          {scan.productName || `باركود ${scan.barcode}`}
                        </div>
                        <div className="mt-1 text-xs text-[var(--text-muted)]" dir="ltr">
                          {scan.barcode}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                          <span>{formatHebronShortDateTime(scan.createdAt)}</span>
                          {scan.productPrice != null ? <span>• {formatMoneyWithCurrency(Number(scan.productPrice))}</span> : null}
                          <span className={isSending ? 'font-semibold text-amber-700' : ''}>
                            • {isSending ? 'قيد الإرسال' : 'بانتظار الإرسال'}
                          </span>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0 rounded-2xl"
                        disabled={isSending}
                        onClick={() => {
                          void removeQueuedScan(scan.scanId)
                          publishNotice('تم حذف القراءة المؤجلة.', 'success')
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <Card className="rounded-[22px] border-dashed bg-[var(--app-bg)] p-5 text-center text-sm text-[var(--text-muted)] shadow-none">
                لا توجد قراءات مؤجلة حاليًا.
              </Card>
            )}

            <Button type="button" variant="secondary" className="w-full" onClick={() => setQueuedScansOpen(false)}>
              إغلاق
            </Button>
          </div>
        </Dialog>
        </div>
      </div>
    </>
  )
}

async function startScanner({
  videoRef,
  quaggaTargetRef,
  streamRef,
  detectorRef,
  animationRef,
  quaggaRef,
  quaggaHandlerRef,
  html5QrRef,
  zxingReaderRef,
  scanStateRef,
  onDetected,
  cameraSelection,
  initialStream,
}: ScannerStartArgs) {
  const video = videoRef.current
  const quaggaTarget = quaggaTargetRef.current
  if (!video) throw new Error('عنصر الفيديو غير جاهز.')
  if (!quaggaTarget) throw new Error('منطقة المعاينة غير جاهزة.')

  const preferFrontCameraPipeline = cameraSelection?.facing === 'user'
  const androidLike = isAndroidLike()
  const iosLike = isIosLike()

  if (androidLike && !preferFrontCameraPipeline) {
    let androidLastError: unknown = null
    let reusableStream = initialStream ?? null

    try {
      if (window.BarcodeDetector) {
        await startNativeDetectorScanner(
          video,
          streamRef,
          detectorRef,
          animationRef,
          scanStateRef,
          onDetected,
          cameraSelection,
          reusableStream,
        )
        return 'BarcodeDetector'
      }
    } catch (error) {
      androidLastError = error
      await stopScanner(videoRef, quaggaTargetRef, streamRef, detectorRef, animationRef, quaggaRef, quaggaHandlerRef, html5QrRef, zxingReaderRef)
      reusableStream = null
    }

    try {
      await startZXingScanner(video, streamRef, zxingReaderRef, onDetected, cameraSelection, reusableStream)
      return 'ZXing'
    } catch (error) {
      androidLastError = androidLastError ?? error
      await stopScanner(videoRef, quaggaTargetRef, streamRef, detectorRef, animationRef, quaggaRef, quaggaHandlerRef, html5QrRef, zxingReaderRef)
    }

    try {
      await startQuaggaScanner(quaggaTarget, quaggaRef, quaggaHandlerRef, onDetected, cameraSelection)
      return 'Quagga2'
    } catch (error) {
      const reason = formatScannerError(androidLastError ?? error)
      throw new Error(`تعذر تشغيل ماسح Android على هذا الجهاز. ${reason}`)
    }
  }

  if (iosLike && !preferFrontCameraPipeline) {
    try {
      await startQuaggaScanner(quaggaTarget, quaggaRef, quaggaHandlerRef, onDetected, cameraSelection)
      return 'Quagga2'
    } catch {
      // continue fallback chain
    }
  }

  if (window.BarcodeDetector) {
    try {
      await startNativeDetectorScanner(video, streamRef, detectorRef, animationRef, scanStateRef, onDetected, cameraSelection)
      return 'BarcodeDetector'
    } catch {
      // continue fallback chain
    }
  }

  try {
    await startZXingScanner(video, streamRef, zxingReaderRef, onDetected, cameraSelection)
    return 'ZXing'
  } catch {
    // final fallback
  }

  try {
    await startQuaggaScanner(quaggaTarget, quaggaRef, quaggaHandlerRef, onDetected, cameraSelection)
    return 'Quagga2'
  } catch {
    throw new Error('تعذر تشغيل أي محرك مسح على هذا الجهاز.')
  }
}

async function stopScanner(
  videoRef: React.MutableRefObject<HTMLVideoElement | null>,
  quaggaTargetRef: React.MutableRefObject<HTMLDivElement | null>,
  streamRef: React.MutableRefObject<MediaStream | null>,
  detectorRef: React.MutableRefObject<InstanceType<BarcodeDetectorCtor> | null>,
  animationRef: React.MutableRefObject<number | null>,
  quaggaRef: React.MutableRefObject<QuaggaModule | null>,
  quaggaHandlerRef: React.MutableRefObject<((result: { codeResult?: { code?: string } }) => void) | null>,
  html5QrRef: React.MutableRefObject<{ stop: () => Promise<void>; clear: () => void } | null>,
  zxingReaderRef: React.MutableRefObject<{ reset?: () => void; stopContinuousDecode?: () => void } | null>,
) {
  if (animationRef.current) {
    window.cancelAnimationFrame(animationRef.current)
    animationRef.current = null
  }

  detectorRef.current = null

  if (html5QrRef.current) {
    try {
      await html5QrRef.current.stop()
    } catch {
      // ignore
    }
    try {
      html5QrRef.current.clear()
    } catch {
      // ignore
    }
    html5QrRef.current = null
  }

  if (zxingReaderRef.current) {
    try {
      zxingReaderRef.current.reset?.()
      zxingReaderRef.current.stopContinuousDecode?.()
    } catch {
      // ignore
    }
    zxingReaderRef.current = null
  }

  if (quaggaRef.current) {
    try {
      if (quaggaHandlerRef.current && quaggaRef.current.offDetected) {
        quaggaRef.current.offDetected(quaggaHandlerRef.current)
      }
    } catch {
      // ignore
    }
    try {
      quaggaRef.current.stop()
    } catch {
      // ignore
    }
  }
  quaggaHandlerRef.current = null
  quaggaRef.current = null

  if (streamRef.current) {
    try {
      streamRef.current.getTracks().forEach((track) => track.stop())
    } catch {
      // ignore
    }
    streamRef.current = null
  }

  if (videoRef.current) {
    try {
      videoRef.current.pause()
    } catch {
      // ignore
    }
    videoRef.current.srcObject = null
  }

  if (quaggaTargetRef.current) {
    quaggaTargetRef.current.innerHTML = ''
  }
}

async function startQuaggaScanner(
  target: HTMLDivElement,
  quaggaRef: React.MutableRefObject<QuaggaModule | null>,
  quaggaHandlerRef: React.MutableRefObject<((result: { codeResult?: { code?: string } }) => void) | null>,
  onDetected: (barcode: string) => void,
  cameraSelection?: CameraSelection,
) {
  target.innerHTML = ''
  const { default: Quagga } = await import('@ericblade/quagga2')
  const quagga = Quagga as unknown as QuaggaModule
  quaggaRef.current = quagga

  const cameraConstraints = buildCameraConstraints(cameraSelection)

  await new Promise<void>((resolve, reject) => {
    quagga.init(
      {
        inputStream: {
          type: 'LiveStream',
          target,
          constraints: {
            ...cameraConstraints,
            aspectRatio: { ideal: 1.6 },
          },
          area: {
            top: '32%',
            right: '10%',
            left: '10%',
            bottom: '32%',
          },
        },
        locator: {
          patchSize: 'medium',
          halfSample: true,
        },
        numOfWorkers: 0,
        locate: false,
        frequency: 16,
        decoder: {
          readers: ['ean_reader'],
        },
      },
      (error?: Error | null) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      },
    )
  })

  quaggaHandlerRef.current = (result) => {
    const code = result?.codeResult?.code
    if (code) onDetected(code)
  }

  quagga.onDetected(quaggaHandlerRef.current)
  quagga.start()
  window.setTimeout(() => styleQuaggaSurface(target), 150)
}

async function startNativeDetectorScanner(
  video: HTMLVideoElement,
  streamRef: React.MutableRefObject<MediaStream | null>,
  detectorRef: React.MutableRefObject<InstanceType<BarcodeDetectorCtor> | null>,
  animationRef: React.MutableRefObject<number | null>,
  scanStateRef: React.MutableRefObject<ScanState>,
  onDetected: (barcode: string) => void,
  cameraSelection?: CameraSelection,
  initialStream?: MediaStream | null,
) {
  const supportedFormats = typeof window.BarcodeDetector?.getSupportedFormats === 'function'
    ? await window.BarcodeDetector.getSupportedFormats!().catch(() => [])
    : []
  if (supportedFormats.length && !supportedFormats.includes('ean_13')) {
    throw new Error('BarcodeDetector لا يدعم EAN-13 على هذا الجهاز.')
  }

  const stream = initialStream ?? (await openPreferredCamera(cameraSelection))
  streamRef.current = stream
  video.srcObject = stream
  video.playsInline = true
  video.muted = true
  await video.play()
  await waitForVideoFrame(video)

  const detector = new window.BarcodeDetector!({
    formats: ['ean_13'],
  })
  detectorRef.current = detector
  startDetectLoop(video, detectorRef, animationRef, scanStateRef, onDetected)
}

async function startZXingScanner(
  video: HTMLVideoElement,
  streamRef: React.MutableRefObject<MediaStream | null>,
  zxingReaderRef: React.MutableRefObject<{ reset?: () => void; stopContinuousDecode?: () => void } | null>,
  onDetected: (barcode: string) => void,
  cameraSelection?: CameraSelection,
  initialStream?: MediaStream | null,
) {
  const ZXing = (await import('@zxing/library')) as ZXingModule
  const stream = initialStream ?? (await openPreferredCamera(cameraSelection))
  streamRef.current = stream
  video.srcObject = stream
  video.playsInline = true
  video.muted = true
  await video.play()

  const hints = new Map()
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true)
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13])

  const reader = new ZXing.BrowserMultiFormatReader(hints, 180)
  zxingReaderRef.current = reader as typeof zxingReaderRef.current
  const anyReader = reader as unknown as {
    decodeFromVideoElement?: (videoElement: HTMLVideoElement, callback: (result: { getText: () => string } | null) => void) => void
    decodeFromVideoElementContinuously?: (videoElement: HTMLVideoElement, callback: (result: { getText: () => string } | null) => void) => void
  }

  if (typeof anyReader.decodeFromVideoElementContinuously === 'function') {
    anyReader.decodeFromVideoElementContinuously(video, (result) => {
      if (result) onDetected(result.getText())
    })
    return
  }

  if (typeof anyReader.decodeFromVideoElement === 'function') {
    anyReader.decodeFromVideoElement(video, (result) => {
      if (result) onDetected(result.getText())
    })
    return
  }

  throw new Error('ZXing لا يدعم decodeFromVideoElement على هذا الجهاز.')
}

function startDetectLoop(
  video: HTMLVideoElement,
  detectorRef: React.MutableRefObject<InstanceType<BarcodeDetectorCtor> | null>,
  animationRef: React.MutableRefObject<number | null>,
  scanStateRef: React.MutableRefObject<ScanState>,
  onDetected: (barcode: string) => void,
) {
  let detecting = false
  let lastDetectAt = 0

  const tick = async (now = window.performance.now()) => {
    if (scanStateRef.current === 'paused') {
      animationRef.current = window.requestAnimationFrame(tick)
      return
    }

    try {
      if (
        detecting ||
        now - lastDetectAt < NATIVE_DETECT_INTERVAL_MS ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        video.videoWidth <= 0 ||
        video.videoHeight <= 0
      ) {
        animationRef.current = window.requestAnimationFrame(tick)
        return
      }

      const detector = detectorRef.current
      if (detector) {
        detecting = true
        lastDetectAt = now
        const codes = await detector.detect(video)
        const first = codes[0]
        const value = first?.rawValue || first?.value
        if (value) onDetected(value)
      }
    } catch {
      // ignore frame errors
    } finally {
      detecting = false
    }

    animationRef.current = window.requestAnimationFrame(tick)
  }

  animationRef.current = window.requestAnimationFrame(tick)
}

function createBarcodeHandler({ scanStateRef, lastAcceptedRef, onAccepted, onDuplicate }: BarcodeHandlerOptions) {
  return (barcode: string) => {
    if (scanStateRef.current === 'paused') return

    const value = String(barcode || '').trim()
    if (!isValidEAN13(value)) return

    const now = Date.now()
    const lastAccepted = lastAcceptedRef.current
    if (lastAccepted && lastAccepted.value === value && now - lastAccepted.at < SAME_BARCODE_COOLDOWN_MS) {
      onDuplicate(value)
      return
    }

    lastAcceptedRef.current = { value, at: now }
    onAccepted(value)
  }
}


