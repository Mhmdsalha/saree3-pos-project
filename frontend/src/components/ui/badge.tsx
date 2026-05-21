import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Badge({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('inline-flex items-center justify-center rounded-full px-3 py-1 text-sm font-semibold', className)} {...props} />
}
