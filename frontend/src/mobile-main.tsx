import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProviders } from '@/app/providers'
import '@/styles/globals.css'
import { MobileApp } from '@/mobile/mobile-app'

createRoot(document.getElementById('mobile-root')!).render(
  <StrictMode>
    <AppProviders>
      <MobileApp />
    </AppProviders>
  </StrictMode>,
)
