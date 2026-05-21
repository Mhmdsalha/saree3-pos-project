import JsBarcode from 'jsbarcode'
import { getStoredCurrencyLabel, getStoredShopName } from '@/lib/storefront'

export const BARCODE_PRINT_MIN_QUANTITY = 1
export const BARCODE_PRINT_MAX_QUANTITY = 200

export type PrintableBarcodeLabel = {
  productName: string
  barcode: string
  unit?: string | null
  price?: number | null
}

export type BarcodePrintTarget = {
  popup?: Window | null
  iframe?: HTMLIFrameElement | null
}

export function validateBarcodePrintQuantity(value: string | number) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || Number.isNaN(numeric)) {
    return { ok: false as const, message: 'عدد النسخ يجب أن يكون رقمًا صحيحًا.' }
  }
  if (numeric < BARCODE_PRINT_MIN_QUANTITY) {
    return { ok: false as const, message: 'عدد النسخ يجب أن يكون 1 على الأقل.' }
  }
  if (numeric > BARCODE_PRINT_MAX_QUANTITY) {
    return { ok: false as const, message: `الحد الأقصى للطباعة هو ${BARCODE_PRINT_MAX_QUANTITY} نسخة.` }
  }
  return { ok: true as const, quantity: numeric }
}

export function buildBarcodeSvgMarkup(barcode: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  JsBarcode(svg, barcode, {
    format: 'EAN13',
    displayValue: false,
    margin: 0,
    width: 1.6,
    height: 46,
    background: '#ffffff',
  })
  return svg.outerHTML
}

export function createBarcodePrintTarget(): BarcodePrintTarget {
  try {
    const popup = window.open('', '_blank', 'width=920,height=720')
    if (popup) {
      popup.document.write(
        '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8" /><title>تجهيز الطباعة</title></head><body style="font-family:Tahoma,Arial,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#1f2937"><div>جاري تجهيز طباعة الباركود...</div></body></html>',
      )
      popup.document.close()
      popup.focus()
      return { popup }
    }
  } catch {
    // Some WebView environments block popups. Fall back to the invoice-style iframe print path.
  }

  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.style.opacity = '0'
  document.body.appendChild(iframe)
  return { iframe }
}

export function closeBarcodePrintTarget(target?: BarcodePrintTarget) {
  if (target?.iframe?.parentNode) {
    target.iframe.parentNode.removeChild(target.iframe)
  }
  if (target?.popup && !target.popup.closed) {
    target.popup.close()
  }
}

export function printBarcodeLabels(label: PrintableBarcodeLabel, quantity: number, target?: BarcodePrintTarget) {
  const validation = validateBarcodePrintQuantity(quantity)
  if (!validation.ok) {
    throw new Error(validation.message)
  }

  const productName = escapeHtml(label.productName)
  const barcode = String(label.barcode || '').trim()
  if (!/^\d{13}$/.test(barcode)) {
    throw new Error('الباركود غير صالح للطباعة.')
  }

  const currency = escapeHtml(getStoredCurrencyLabel())
  const storeName = escapeHtml(getStoredShopName())
  const unit = label.unit ? escapeHtml(label.unit) : ''
  const priceMarkup =
    typeof label.price === 'number' && Number.isFinite(label.price)
      ? `<div class="label-price">${escapeHtml(label.price.toFixed(2))} ${currency}</div>`
      : ''
  const unitMarkup = unit ? `<div class="label-unit">${unit}</div>` : ''
  const barcodeSvg = buildBarcodeSvgMarkup(barcode)

  const labelsHtml = Array.from({ length: validation.quantity }, () => {
    return [
      '<section class="barcode-label">',
      `<div class="label-store">${storeName}</div>`,
      `<div class="label-name">${productName}</div>`,
      `<div class="label-svg">${barcodeSvg}</div>`,
      `<div class="label-code">${escapeHtml(barcode)}</div>`,
      unitMarkup,
      priceMarkup,
      '</section>',
    ].join('')
  }).join('')

  const html = [
    '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8" />',
    '<title>طباعة باركود</title>',
    '<style>',
    '@page { size: A4 portrait; margin: 10mm; }',
    '* { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; font-family: Tahoma, Arial, sans-serif; background: #fff; }',
    '.sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8mm 6mm; align-content: start; }',
    '.barcode-label { min-height: 38mm; border: 1px solid #ece5da; border-radius: 5mm; padding: 4mm 3mm; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; overflow: hidden; }',
    '.label-store { font-size: 10px; color: #9a5800; font-weight: 700; margin-bottom: 2mm; }',
    '.label-name { font-size: 12px; font-weight: 800; color: #1f2937; line-height: 1.35; min-height: 32px; }',
    '.label-svg { margin: 2mm 0 1mm; }',
    '.label-svg svg { width: 100%; max-width: 54mm; height: auto; display: block; }',
    '.label-code { font-size: 12px; font-weight: 800; letter-spacing: 1px; color: #111827; direction: ltr; }',
    '.label-unit, .label-price { font-size: 10px; color: #6b7280; margin-top: 1mm; }',
    '</style></head><body>',
    `<main class="sheet">${labelsHtml}</main>`,
    '</body></html>',
  ].join('')

  if (target?.popup && !target.popup.closed) {
    target.popup.document.open()
    target.popup.document.write(html)
    target.popup.document.close()
    target.popup.onafterprint = () => {
      window.setTimeout(() => {
        if (target.popup && !target.popup.closed) {
          target.popup.close()
        }
      }, 300)
    }
    window.setTimeout(() => {
      target.popup?.focus()
      target.popup?.print()
    }, 120)
    return
  }

  const iframe = target?.iframe ?? document.createElement('iframe')
  if (!target?.iframe) {
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    iframe.style.opacity = '0'
    document.body.appendChild(iframe)
  }

  const printDocument = iframe.contentDocument || iframe.contentWindow?.document
  if (!printDocument) {
    throw new Error('تعذر فتح نافذة الطباعة.')
  }
  printDocument.open()
  printDocument.write(html)
  printDocument.close()
  window.setTimeout(() => {
    try {
      iframe.contentWindow?.focus()
      iframe.contentWindow?.print()
    } finally {
      window.setTimeout(() => {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe)
        }
      }, 1200)
    }
  }, 120)
}

function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
