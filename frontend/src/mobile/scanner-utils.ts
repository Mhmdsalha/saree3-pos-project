export type CameraSelection = {
  deviceId?: string | null
  facing?: 'environment' | 'user'
}

export function isValidEAN13(barcode: string) {
  const value = String(barcode || '').trim()
  if (!/^\d{13}$/.test(value)) return false

  let sum = 0
  for (let index = 0; index < 12; index += 1) {
    sum += Number.parseInt(value[index], 10) * (index % 2 === 0 ? 1 : 3)
  }
  return (10 - (sum % 10)) % 10 === Number.parseInt(value[12], 10)
}

export function isIosLike() {
  const ua = window.navigator.userAgent
  const platform = window.navigator.platform
  const touchPoints = window.navigator.maxTouchPoints || 0
  return /iPad|iPhone|iPod/i.test(ua) || (platform === 'MacIntel' && touchPoints > 1)
}

export function isAndroidLike() {
  return /Android/i.test(window.navigator.userAgent)
}

export function buildCameraConstraints(selection?: CameraSelection): MediaTrackConstraints {
  const androidLike = isAndroidLike()
  const constraints: MediaTrackConstraints = {
    width: { ideal: androidLike ? 640 : 1280 },
    height: { ideal: androidLike ? 480 : 720 },
  }

  if (selection?.deviceId) {
    constraints.deviceId = { exact: selection.deviceId }
  } else {
    constraints.facingMode = { ideal: selection?.facing ?? 'environment' }
  }

  return constraints
}

export async function openPreferredCamera(selection?: CameraSelection) {
  const attempts: Array<MediaTrackConstraints | true> = [
    buildCameraConstraints(selection),
  ]

  if (isAndroidLike()) {
    attempts.push(
      {
        facingMode: { ideal: selection?.facing ?? 'environment' },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      {
        facingMode: { ideal: selection?.facing ?? 'environment' },
      },
      true,
    )
  }

  let lastError: unknown = null

  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: constraints,
        audio: false,
      })
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('تعذر تشغيل الكاميرا على هذا الجهاز.')
}

export function styleQuaggaSurface(target: HTMLDivElement) {
  target.querySelectorAll('video, canvas').forEach((element) => {
    const node = element as HTMLElement
    node.style.width = '100%'
    node.style.height = '100%'
    node.style.objectFit = 'cover'
    node.style.position = 'absolute'
    node.style.inset = '0'
  })
}

export async function waitForVideoFrame(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('تعذر تهيئة معاينة الكاميرا.'))
    }, 4_000)

    const onReady = () => {
      cleanup()
      resolve()
    }

    const cleanup = () => {
      window.clearTimeout(timeout)
      video.removeEventListener('loadeddata', onReady)
      video.removeEventListener('canplay', onReady)
    }

    video.addEventListener('loadeddata', onReady)
    video.addEventListener('canplay', onReady)
  })

  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
}

export function formatScannerError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      if (isCameraOverlayPermissionError(error)) {
        return 'تعذر منح صلاحية الكاميرا لأن أندرويد رصد تراكبات أو فقاعات فوق الشاشة.'
      }
      return 'تم رفض إذن الكاميرا.'
    }
    if (error.name === 'NotReadableError') return 'الكاميرا مشغولة من تطبيق آخر.'
    if (error.name === 'OverconstrainedError') return 'إعدادات الكاميرا غير مدعومة على هذا الجهاز.'
    if (error.name === 'NotFoundError') return 'لم يتم العثور على كاميرا مناسبة.'
    return error.message || error.name
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'فشل غير معروف أثناء تشغيل الماسح.'
}

export function isCameraOverlayPermissionError(error: unknown) {
  const text =
    typeof error === 'string'
      ? error
      : error instanceof Error || error instanceof DOMException
        ? `${error.name} ${error.message}`
        : ''

  return /overlay|obscur|draw over|display over|screen overlay|floating|bubble|تراكب|تراكبات|فقاعات|فوق التطبيقات/i.test(
    text,
  )
}
