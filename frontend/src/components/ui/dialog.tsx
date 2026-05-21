import type { PropsWithChildren } from 'react'
import { cn } from '@/lib/utils'

type DialogProps = PropsWithChildren<{
  open: boolean
  onClose: () => void
  className?: string
}>

export function Dialog({ open, onClose, children, className }: DialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className={cn('w-full max-w-lg rounded-[28px] border border-[var(--line)] bg-white p-6 shadow-[0_22px_60px_rgba(15,23,42,0.25)]', className)}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
