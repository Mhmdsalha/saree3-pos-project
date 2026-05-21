export function formatHebronDateTime(date: Date) {
  return new Intl.DateTimeFormat('ar-PS', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: APP_TIME_ZONE,
  }).format(date)
}

export const APP_TIME_ZONE = 'Asia/Hebron'

export function formatHebronShortDateTime(value?: string | Date | null) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat('ar-PS', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: APP_TIME_ZONE,
  }).format(date)
}

export function hebronDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE }).format(date)
}

export function hebronMonthKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value
      return acc
    }, {})
  return `${parts.year}-${parts.month}`
}

export function formatHebronDayLabel(value: string) {
  const parsed = new Date(`${value}T12:00:00`)
  return new Intl.DateTimeFormat('ar-PS', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: APP_TIME_ZONE,
  }).format(parsed)
}
