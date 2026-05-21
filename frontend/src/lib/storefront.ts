import { apiGet, resolveApiOrigin } from '@/lib/api-client'
import { SYSTEM_BRAND_NAME } from '@/lib/system-branding'
import type { Storefront } from '@/types/api'

export const SHOP_NAME_KEY = 'pos_shop_name'
export const STORE_CURRENCY_KEY = 'pos_currency'
export const STORE_TYPE_KEY = 'pos_store_type'
export const STORE_LOGO_URL_KEY = 'pos_store_logo_url'
export const STOREFRONT_BRANDING_REVISION_KEY = 'pos_storefront_branding_revision'
export const STOREFRONT_UPDATED_EVENT = 'flowpos:storefront-updated'

const DEFAULT_STORE_NAME = SYSTEM_BRAND_NAME
const DEFAULT_CURRENCY = 'ILS'
const STORE_TYPE_LABELS: Record<string, string> = {
  supermarket: 'سوبرماركت',
  clothing: 'ملابس',
  pharmacy: 'صيدلية',
  cosmetics: 'مستحضرات تجميل',
}

export async function loadPublicStorefront() {
  return apiGet<Storefront>('/launcher/public-storefront')
}

export async function primeStorefrontBranding() {
  try {
    const storefront = await loadPublicStorefront()
    if (!storefront.initialized) return storefront

    const nextStoreName = storefront.store_name?.trim() || DEFAULT_STORE_NAME
    const nextCurrency = storefront.currency?.trim().toUpperCase() || DEFAULT_CURRENCY
    const nextStoreType = storefront.store_type?.trim().toLowerCase() || null
    const nextLogoUrl = normalizeStoredLogoUrl(storefront.logo_url || null)
    const nextBrandingRevision = storefront.branding_revision?.trim() || null
    const previousStoreName = window.localStorage.getItem(SHOP_NAME_KEY)?.trim() || DEFAULT_STORE_NAME
    const previousCurrency = window.localStorage.getItem(STORE_CURRENCY_KEY)?.trim().toUpperCase() || DEFAULT_CURRENCY
    const previousStoreType = window.localStorage.getItem(STORE_TYPE_KEY)?.trim().toLowerCase() || null
    const previousLogoUrl = normalizeStoredLogoUrl(window.localStorage.getItem(STORE_LOGO_URL_KEY))
    const previousBrandingRevision = window.localStorage.getItem(STOREFRONT_BRANDING_REVISION_KEY)?.trim() || null

    if (storefront.store_name?.trim()) {
      window.localStorage.setItem(SHOP_NAME_KEY, nextStoreName)
    }
    if (storefront.currency?.trim()) {
      window.localStorage.setItem(STORE_CURRENCY_KEY, nextCurrency)
    }
    if (nextStoreType) {
      window.localStorage.setItem(STORE_TYPE_KEY, nextStoreType)
    } else {
      window.localStorage.removeItem(STORE_TYPE_KEY)
    }
    if (nextLogoUrl) {
      window.localStorage.setItem(STORE_LOGO_URL_KEY, nextLogoUrl)
    } else {
      window.localStorage.removeItem(STORE_LOGO_URL_KEY)
    }
    if (nextBrandingRevision) {
      window.localStorage.setItem(STOREFRONT_BRANDING_REVISION_KEY, nextBrandingRevision)
    } else {
      window.localStorage.removeItem(STOREFRONT_BRANDING_REVISION_KEY)
    }

    if (
      previousStoreName !== nextStoreName ||
      previousCurrency !== nextCurrency ||
      previousStoreType !== nextStoreType ||
      previousLogoUrl !== nextLogoUrl ||
      previousBrandingRevision !== nextBrandingRevision
    ) {
      window.dispatchEvent(
        new CustomEvent(STOREFRONT_UPDATED_EVENT, {
          detail: {
            store_name: nextStoreName,
            currency: nextCurrency,
            store_type: nextStoreType,
            logo_url: nextLogoUrl,
            branding_revision: nextBrandingRevision,
          },
        }),
      )
    }
    return storefront
  } catch {
    return null
  }
}

export function getStoredShopName() {
  return window.localStorage.getItem(SHOP_NAME_KEY)?.trim() || DEFAULT_STORE_NAME
}

export function getStoredCurrencyLabel() {
  return window.localStorage.getItem(STORE_CURRENCY_KEY)?.trim().toUpperCase() || DEFAULT_CURRENCY
}

export function getStoredStoreType() {
  return window.localStorage.getItem(STORE_TYPE_KEY)?.trim().toLowerCase() || null
}

function normalizeStoredLogoUrl(value: string | null | undefined) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  return `${resolveApiOrigin(true)}${raw.startsWith('/') ? raw : `/${raw}`}`
}

export function getStoredStoreLogoUrl() {
  return normalizeStoredLogoUrl(window.localStorage.getItem(STORE_LOGO_URL_KEY))
}

export function getStoredStoreTypeLabel() {
  const storeType = getStoredStoreType()
  if (!storeType) return null
  return STORE_TYPE_LABELS[storeType] || storeType
}

export function storeSupportsWeightedProducts(storeType = getStoredStoreType()) {
  return storeType === 'supermarket'
}

export function formatMoneyWithCurrency(value: number) {
  return `${Number(value || 0).toFixed(2)} ${getStoredCurrencyLabel()}`
}
