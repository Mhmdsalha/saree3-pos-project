import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'

export type AppToast = {
  id: number
  message: string
  tone: 'success' | 'warning' | 'error' | 'info'
}

type ToastStackProps = {
  notices: AppToast[]
}

const toneMap: Record<AppToast['tone'], { icon: typeof CheckCircle2; className: string }> = {
  success: {
    icon: CheckCircle2,
    className: 'border-emerald-200 bg-emerald-50/95 text-emerald-800',
  },
  warning: {
    icon: AlertTriangle,
    className: 'border-amber-200 bg-amber-50/95 text-amber-800',
  },
  error: {
    icon: XCircle,
    className: 'border-red-200 bg-red-50/95 text-red-800',
  },
  info: {
    icon: Info,
    className: 'border-orange-200 bg-white/95 text-[var(--text-strong)]',
  },
}

export function ToastStack({ notices }: ToastStackProps) {
  if (!notices.length) {
    return null
  }

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[120] flex w-[min(92vw,560px)] -translate-x-1/2 flex-col-reverse gap-3">
      {notices.map((notice) => {
        const tone = toneMap[notice.tone]
        const Icon = tone.icon
        return (
          <div
            key={notice.id}
            className={`pointer-events-auto flex items-center gap-3 rounded-[22px] border px-4 py-3 shadow-[0_18px_46px_rgba(15,23,42,0.14)] backdrop-blur-sm ${tone.className}`}
            role="status"
            aria-live="polite"
          >
            <Icon className="h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1 text-sm font-bold leading-6">{notice.message}</div>
          </div>
        )
      })}
    </div>
  )
}
