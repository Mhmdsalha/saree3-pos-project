import { useEffect } from 'react'

export type LauncherToastTone = 'success' | 'error' | 'info'

export type LauncherToastState = {
  text: string
  tone: LauncherToastTone
  durationMs?: number
}

type LauncherToastProps = {
  toast: LauncherToastState | null
  onClose: () => void
}

function toneIcon(tone: LauncherToastTone) {
  switch (tone) {
    case 'success':
      return '✓'
    case 'error':
      return '!'
    default:
      return 'i'
  }
}

export function LauncherToast({ toast, onClose }: LauncherToastProps) {
  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(onClose, toast.durationMs ?? 4200)
    return () => window.clearTimeout(timeout)
  }, [toast, onClose])

  if (!toast) return null

  return (
    <div className={`launcher-toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
      <span className="launcher-toast-icon" aria-hidden="true">
        {toneIcon(toast.tone)}
      </span>
      <p>{toast.text}</p>
      <button type="button" className="launcher-toast-close" onClick={onClose} aria-label="إغلاق الإشعار">
        ×
      </button>
    </div>
  )
}
