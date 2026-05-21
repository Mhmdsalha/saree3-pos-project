import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppToast } from '@/components/ui/toast-stack'

export type NoticeTone = AppToast['tone']

type NoticeDetail = {
  message: string
  tone?: NoticeTone
  ttl?: number
}

const NOTICE_EVENT = 'flowpos:notice'
const DEFAULT_TTL = 3400
const DEDUPE_WINDOW_MS = 1800

export function publishNotice(message: string, tone: NoticeTone = 'info', ttl = DEFAULT_TTL) {
  if (!message.trim()) return
  window.dispatchEvent(
    new CustomEvent<NoticeDetail>(NOTICE_EVENT, {
      detail: { message, tone, ttl },
    }),
  )
}

export function useNoticeCenter() {
  const [notices, setNotices] = useState<AppToast[]>([])
  const noticeIdRef = useRef(0)
  const recentRef = useRef<Map<string, number>>(new Map())

  const pushNotice = useCallback((message: string, tone: NoticeTone = 'info', ttl = DEFAULT_TTL) => {
    const text = message.trim()
    if (!text) return

    const key = `${tone}:${text}`
    const now = Date.now()
    const lastSeen = recentRef.current.get(key) ?? 0
    if (now - lastSeen < DEDUPE_WINDOW_MS) {
      return
    }
    recentRef.current.set(key, now)

    const id = ++noticeIdRef.current
    setNotices((current) => [...current, { id, message: text, tone }])
    window.setTimeout(() => {
      setNotices((current) => current.filter((notice) => notice.id !== id))
    }, ttl)
  }, [])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NoticeDetail>).detail
      if (!detail?.message) return
      pushNotice(detail.message, detail.tone ?? 'info', detail.ttl ?? DEFAULT_TTL)
    }

    window.addEventListener(NOTICE_EVENT, handler as EventListener)
    return () => {
      window.removeEventListener(NOTICE_EVENT, handler as EventListener)
    }
  }, [pushNotice])

  return { notices, pushNotice }
}
