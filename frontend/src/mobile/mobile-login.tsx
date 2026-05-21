import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { StoredSession } from '@/lib/auth'
import { publishNotice } from '@/lib/notice-center'
import { SYSTEM_BRAND_NAME, SYSTEM_BRAND_TAGLINE, SYSTEM_LOGO_DARK_URL } from '@/lib/system-branding'
import { defaultMobileServer, normalizeOrigin, persistMobileSession } from '@/mobile/session-utils'
import type { LoginResponse } from '@/types/api'

type MobileLoginProps = {
  onLogin: (session: StoredSession) => void
}

export function MobileLogin({ onLogin }: MobileLoginProps) {
  const [serverUrl, setServerUrl] = useState(defaultMobileServer())
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoading(true)

    try {
      const normalizedServerUrl = normalizeOrigin(serverUrl)
      const body = new URLSearchParams({ username, password })
      const response = await fetch(`${normalizedServerUrl}/auth/login`, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      if (!response.ok) {
        throw new Error('بيانات الدخول غير صحيحة أو الخادم غير متاح.')
      }

      const data = (await response.json()) as LoginResponse
      const openSessionResponse = await fetch(`${normalizedServerUrl}/sessions/open`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${data.access_token}`,
        },
      })

      const sessionToken = openSessionResponse.ok
        ? ((await openSessionResponse.json()) as { session_token: string }).session_token
        : data.access_token

      onLogin(
        persistMobileSession({
          serverUrl: normalizeOrigin(serverUrl),
          token: data.access_token,
          sessionToken,
          user: data.user,
        }),
      )
    } catch (submitError) {
      publishNotice(submitError instanceof Error ? submitError.message : 'تعذر إكمال تسجيل الدخول.', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] px-4 py-6">
      <Card className="w-full max-w-md border-white/70 bg-white/88 p-6 shadow-[0_22px_60px_rgba(15,23,42,0.14)] backdrop-blur-xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex justify-center">
            <img src={SYSTEM_LOGO_DARK_URL} alt={`شعار ${SYSTEM_BRAND_NAME}`} className="h-14 w-auto object-contain" />
          </div>
          <div className="mb-2 text-xs font-bold tracking-[0.16em] text-[var(--brand)]">{SYSTEM_BRAND_TAGLINE}</div>
          <h1 className="text-3xl font-black">تسجيل دخول الموبايل</h1>
          <p className="mt-2 text-sm text-[var(--text-muted)]">اربط الموبايل بنفس جلسة الكاشير الحالية ليعمل الماسح مباشرة وبشكل مستقر على iPhone وAndroid.</p>
        </div>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <Input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://192.168.1.7:8000" />
          <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="اسم المستخدم" />
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="كلمة السر" />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'جارٍ الدخول...' : 'الدخول إلى الماسح'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
