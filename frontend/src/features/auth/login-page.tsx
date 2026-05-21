import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { resolveApiOrigin } from '@/lib/api-client'
import { saveStoredSession, type StoredSession } from '@/lib/auth'
import { SYSTEM_LOGO_DARK_URL } from '@/lib/system-branding'
import type { LoginResponse } from '@/types/api'

type LoginPageProps = {
  onLogin: (session: StoredSession) => void
  onNotice: (message: string, tone?: 'success' | 'warning' | 'error' | 'info') => void
}

export function LoginPage({ onLogin, onNotice }: LoginPageProps) {
  const [serverUrl, setServerUrl] = useState(resolveApiOrigin(true))
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoading(true)

    try {
      const body = new URLSearchParams({ username, password })
      const response = await fetch(`${serverUrl}/auth/login`, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      if (!response.ok) {
        throw new Error('بيانات الدخول غير صحيحة أو الخادم غير متاح.')
      }

      const data = (await response.json()) as LoginResponse
      const openSessionResponse = await fetch(`${serverUrl}/sessions/open`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${data.access_token}`,
        },
      })

      const sessionToken = openSessionResponse.ok
        ? ((await openSessionResponse.json()) as { session_token: string }).session_token
        : data.access_token

      const session = saveStoredSession({
        serverUrl,
        token: data.access_token,
        sessionToken,
        user: data.user,
      })

      onLogin(session)
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'تعذر إكمال تسجيل الدخول.'
      onNotice(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] px-6 py-10">
      <div className="flex w-full max-w-xl flex-col items-center gap-6">
        <img src={SYSTEM_LOGO_DARK_URL} alt="شعار سريع" className="login-system-logo" />

        <Card className="w-full border-white/70 bg-white/88 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.14)] backdrop-blur-xl">
          <div className="mb-8 text-center">
            <h1 className="text-3xl font-black">تسجيل الدخول</h1>
          </div>

          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <label className="block text-sm font-semibold">عنوان السيرفر</label>
              <Input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-semibold">اسم المستخدم</label>
              <Input value={username} onChange={(event) => setUsername(event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-semibold">كلمة السر</label>
              <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>

            <Button type="submit" className="h-14 w-full text-lg font-black" disabled={loading}>
              {loading ? 'جارٍ الدخول...' : 'الدخول إلى النظام'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}
