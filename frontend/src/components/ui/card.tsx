import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: 'solid' | 'glass' | 'glass-subtle'
}

const variantClasses: Record<NonNullable<CardProps['variant']>, string> = {
  solid: 'border border-[var(--line)] bg-[var(--panel)] shadow-[var(--soft-shadow)]',
  glass:
    'border border-[var(--glass-border)] bg-[var(--glass-bg)] shadow-[var(--glass-shadow)] backdrop-blur-[var(--glass-blur)]',
  'glass-subtle':
    'border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] shadow-[var(--glass-shadow-subtle)] backdrop-blur-[calc(var(--glass-blur)*0.8)]',
}

export function Card({ className, variant = 'solid', ...props }: CardProps) {
  return (
    <div
      className={cn('rounded-[28px]', variantClasses[variant], className)}
      {...props}
    />
  )
}
