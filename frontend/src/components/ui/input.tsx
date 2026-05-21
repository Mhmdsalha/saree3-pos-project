import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-2xl border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition-colors placeholder:text-[var(--text-faint)] focus:border-[var(--brand-soft)] focus:ring-4 focus:ring-[color:rgba(245,124,0,0.12)]',
        className,
      )}
      {...props}
    />
  )
})
