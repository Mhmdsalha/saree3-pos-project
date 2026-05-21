import type { ReactNode } from 'react'

type IconProps = {
  className?: string
}

function SvgFrame({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

export function StoreIcon({ className }: IconProps) {
  return <SvgFrame className={className}><path d="M4 10h16v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M3 10 5 5h14l2 5" /><path d="M9 14h6" /></SvgFrame>
}

export function ShieldIcon({ className }: IconProps) {
  return <SvgFrame className={className}><path d="M12 3 6 5.5v5.6c0 4.3 2.7 8.2 6 9.9 3.3-1.7 6-5.6 6-9.9V5.5z" /><path d="m9.5 12 1.8 1.8L15 10" /></SvgFrame>
}

export function ServerIcon({ className }: IconProps) {
  return <SvgFrame className={className}><rect x="4" y="4" width="16" height="6" rx="2" /><rect x="4" y="14" width="16" height="6" rx="2" /><path d="M8 7h.01M8 17h.01M13 7h5M13 17h5" /></SvgFrame>
}

export function TelegramIcon({ className }: IconProps) {
  return <SvgFrame className={className}><path d="m21 4-3.8 17-5.5-4.2-3.2 2.9.6-5.1L19.7 5 4.4 11.2l-3-1.1z" /></SvgFrame>
}

export function PlayIcon({ className }: IconProps) {
  return <SvgFrame className={className}><path d="m9 7 8 5-8 5z" /></SvgFrame>
}

export function LinkIcon({ className }: IconProps) {
  return <SvgFrame className={className}><path d="M10 14 8.5 15.5a3 3 0 0 1-4.2-4.2L7 8.6" /><path d="M14 10 15.5 8.5a3 3 0 0 1 4.2 4.2L17 15.4" /><path d="M8.5 15.5 15.5 8.5" /></SvgFrame>
}

export function BackupIcon({ className }: IconProps) {
  return <SvgFrame className={className}><path d="M12 3v8" /><path d="m8.5 7 3.5-4 3.5 4" /><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></SvgFrame>
}

export function SupportIcon({ className }: IconProps) {
  return <SvgFrame className={className}><path d="M4 13a8 8 0 1 1 16 0" /><path d="M5 13v4a2 2 0 0 0 2 2h1v-6H7a2 2 0 0 0-2 2Zm14 0v4a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2Z" /><path d="M12 19v2" /></SvgFrame>
}

export function HostDeviceIcon({ className }: IconProps) {
  return <SvgFrame className={className}><rect x="3" y="5" width="18" height="12" rx="3" /><path d="M8 20h8" /><path d="M12 17v3" /><path d="M8 9h8M8 12h5" /></SvgFrame>
}

export function ClientDeviceIcon({ className }: IconProps) {
  return <SvgFrame className={className}><rect x="7" y="3" width="10" height="18" rx="3" /><path d="M10 7h4M11 17h2" /><path d="m4 10 2-2m12 8 2-2" /><path d="M6 12h2m8 0h2" /></SvgFrame>
}
