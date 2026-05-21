import { apiGet } from '@/lib/api-client'
import { getStoredUser } from '@/lib/auth'
import { SYSTEM_BRAND_NAME, SYSTEM_BRAND_TAGLINE, SYSTEM_LOGO_DARK_URL } from '@/lib/system-branding'
import { getStoredCurrencyLabel, getStoredShopName, getStoredStoreLogoUrl, primeStorefrontBranding } from '@/lib/storefront'
import type { InvoiceOut } from '@/types/api'

function fmt(value: number) {
  return Number(value || 0).toFixed(2)
}

function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function appLocaleDateTime(value: string | Date, options?: Intl.DateTimeFormatOptions) {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat('ar-PS', {
    timeZone: 'Asia/Hebron',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  }).format(date)
}

export async function printInvoice(invoiceId: number, cashierName = '—') {
  await primeStorefrontBranding()
  const invoice = await apiGet<InvoiceOut>(`/invoices/${invoiceId}`)
  const shopName = getStoredShopName()
  const currencyLabel = getStoredCurrencyLabel()
  const storeLogoUrl = getStoredStoreLogoUrl()
  const payLabel = ({ cash: 'نقدي', card: 'بطاقة', digital: 'رقمي' } as const)[invoice.payment_method] || invoice.payment_method
  const dateStr = appLocaleDateTime(invoice.created_at)
  const storedCashierName = readStoredCashierName()
  const effectiveCashierName = cashierName && cashierName !== '—' ? cashierName : invoice.cashier_name || storedCashierName || '—'

  const itemRows = (invoice.items || [])
    .map((item) => {
      const name = escapeHtml(item.product_name || `منتج #${item.product_id}`)
      const qty = Number(item.quantity % 1 === 0 ? item.quantity : Number(item.quantity).toFixed(2))
      const referenceRow =
        item.product_is_weighted && Number(item.product_unit_price || 0) > 0
          ? `<tr><td colspan="2" style="font-size:10px;color:#9a5800;padding:0 0 4px">سعر الوحدة المرجعي: ${fmt(Number(item.product_unit_price || 0))} ${escapeHtml(currencyLabel)}</td></tr>`
          : ''
      return (
        `<tr><td colspan="2" style="font-size:11.5px;font-weight:700;padding:4px 0 1px">${name}</td></tr>` +
        referenceRow +
        `<tr><td style="font-size:10.5px;color:#444;padding:1px 0 4px;width:65%">${qty} × ${fmt(item.price)} ${escapeHtml(currencyLabel)}</td>` +
        `<td style="font-size:11px;font-weight:800;text-align:left;padding:1px 0 4px;white-space:nowrap">${fmt(item.subtotal)} ${escapeHtml(currencyLabel)}</td></tr>` +
        '<tr><td colspan="2" style="border-top:1px dotted #ddd;padding:0"></td></tr>'
      )
    })
    .join('')

  const customerRow = invoice.customer_name
    ? `<tr><td style="color:#555;font-size:10.5px">العميل</td><td style="font-weight:700;font-size:10.5px;text-align:left">${escapeHtml(invoice.customer_name)}</td></tr>`
    : ''

  const discountRow = invoice.discount > 0
    ? `<tr><td style="color:#444;font-size:11px">الخصم</td><td style="text-align:left;font-weight:700;font-size:11px">- ${fmt(invoice.discount)} ${escapeHtml(currencyLabel)}</td></tr>`
    : ''

  const storeLogoMarkup = storeLogoUrl
    ? `<img src="${escapeHtml(storeLogoUrl)}" alt="Store logo" class="logo store-logo" />`
    : ''
  const systemLogoMarkup = `<img src="${escapeHtml(SYSTEM_LOGO_DARK_URL)}" alt="${escapeHtml(`شعار ${SYSTEM_BRAND_NAME}`)}" class="logo system-logo" />`

  const html =
    '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"/>' +
    '<style>' +
    '@page { size: 80mm auto; margin: 4mm 3mm; }' +
    '* { box-sizing:border-box; margin:0; padding:0; }' +
    'body { font-family:Tahoma,Arial,sans-serif; font-size:12px; color:#000; width:74mm; direction:rtl; }' +
    'table { width:100%; border-collapse:collapse; }' +
    '.center { text-align:center; }' +
    '.brand-row { display:flex; align-items:center; justify-content:center; gap:8px; margin:0 auto 6px; }' +
    '.logo { display:block; object-fit:contain; }' +
    '.store-logo { width:52px; height:52px; }' +
    '.system-logo { width:34px; height:34px; }' +
    '.dashed { border-top:1px dashed #000; margin:5px 0; }' +
    '.solid { border-top:2px solid #000; margin:5px 0; }' +
    '</style></head><body>' +
    `<div class="center" style="margin-bottom:6px"><div class="brand-row">${storeLogoMarkup}${systemLogoMarkup}</div><div style="font-size:18px;font-weight:900;margin-bottom:2px">${escapeHtml(shopName)}</div><div style="font-size:10px;color:#555">${escapeHtml(SYSTEM_BRAND_TAGLINE)} - ${escapeHtml(SYSTEM_BRAND_NAME)}</div></div>` +
    '<div class="dashed"></div>' +
    '<div class="center" style="font-size:13px;font-weight:800;margin:4px 0">فاتورة مبيعات</div>' +
    '<div class="dashed"></div>' +
    '<table style="margin-bottom:4px">' +
    `<tr><td style="color:#555;font-size:10.5px">رقم الفاتورة</td><td style="font-weight:700;font-size:10.5px;text-align:left">#${invoice.id}</td></tr>` +
    `<tr><td style="color:#555;font-size:10.5px">التاريخ</td><td style="font-weight:700;font-size:10.5px;text-align:left">${escapeHtml(dateStr)}</td></tr>` +
    `<tr><td style="color:#555;font-size:10.5px">الكاشير</td><td style="font-weight:700;font-size:10.5px;text-align:left">${escapeHtml(effectiveCashierName)}</td></tr>` +
    customerRow +
    `<tr><td style="color:#555;font-size:10.5px">الدفع</td><td style="font-weight:700;font-size:10.5px;text-align:left">${escapeHtml(payLabel)}</td></tr>` +
    '</table>' +
    '<div class="solid"></div>' +
    '<table style="margin-top:4px"><tbody>' +
    itemRows +
    '</tbody></table>' +
    '<div class="solid"></div>' +
    '<table style="margin-top:4px">' +
    `<tr><td style="color:#444;font-size:11px">المجموع</td><td style="text-align:left;font-weight:700;font-size:11px">${fmt(invoice.total)} ${escapeHtml(currencyLabel)}</td></tr>` +
    discountRow +
    `<tr><td style="font-weight:900;font-size:13px;padding-top:4px">الإجمالي</td><td style="text-align:left;font-weight:900;font-size:13px;padding-top:4px">${fmt(invoice.final_total)} ${escapeHtml(currencyLabel)}</td></tr>` +
    '</table>' +
    '<div class="dashed"></div>' +
    '<div class="center" style="font-size:10px;color:#555;margin-top:6px">شكرًا لزيارتكم</div>' +
    '</body></html>'

  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)
  iframe.srcdoc = html
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus()
      iframe.contentWindow?.print()
    } finally {
      window.setTimeout(() => document.body.removeChild(iframe), 1000)
    }
  }
}

function readStoredCashierName() {
  return getStoredUser()?.user?.name || ''
}
