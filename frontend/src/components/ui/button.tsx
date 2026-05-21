import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl text-xs font-semibold transition-colors disabled:pointer-events-none',
  {
    variants: {
      variant: {
        default:
          'border border-transparent text-white shadow-[0_14px_28px_rgba(245,124,0,0.26)] hover:brightness-105 disabled:text-white/90 disabled:shadow-[0_10px_18px_rgba(245,124,0,0.14)]',
        secondary:
          'border border-transparent text-white shadow-[0_12px_24px_rgba(245,124,0,0.22)] hover:brightness-105 disabled:text-white/90 disabled:shadow-[0_10px_18px_rgba(245,124,0,0.14)]',
        ghost: 'text-[var(--text-strong)] hover:bg-[var(--muted)]',
      },
      size: {
        default: 'h-10 px-3 py-2',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

export function Button({ className, variant, size, asChild = false, style, disabled, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      className={cn(
        buttonVariants({ variant, size }),
        (variant === 'default' || variant === 'secondary') && '!text-white enabled:hover:brightness-105',
        className,
      )}
      style={style}
      disabled={disabled}
      data-app-button=""
      data-variant={variant ?? 'default'}
      data-disabled={disabled ? 'true' : 'false'}
      {...props}
    />
  )
}
