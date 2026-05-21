import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { useCashier } from '@/features/cashier/cashier-context'

export function QrDialog() {
  const { qrDialogOpen, qrUrl, closeQrDialog } = useCashier()
  const [qrImage, setQrImage] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!qrDialogOpen || !qrUrl) {
      setQrImage('')
      return
    }

    QRCode.toDataURL(qrUrl, {
      width: 280,
      margin: 2,
      color: { dark: '#0d1117', light: '#ffffff' },
    })
      .then((value: string) => {
        if (!cancelled) setQrImage(value)
      })
      .catch(() => {
        if (!cancelled) setQrImage('')
      })

    return () => {
      cancelled = true
    }
  }, [qrDialogOpen, qrUrl])

  return (
    <Dialog open={qrDialogOpen} onClose={closeQrDialog} className="max-w-lg text-center">
      <div className="space-y-4">
        <div>
          <div className="text-3xl font-black">ربط الموبايل</div>
          <div className="mt-2 text-sm text-[var(--text-muted)]">صوّر الرمز من تطبيق الموبايل للانضمام لنفس الجلسة.</div>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-right text-sm leading-7 text-slate-800">
          <div className="font-black">تنبيه المتصفح</div>
          <div>iPhone: استخدم Safari فقط. Android: استخدم Google Chrome فقط. لا تستخدم Chrome على iPhone ولا المتصفح الداخلي للتطبيقات على Android.</div>
        </div>
        <div className="mx-auto flex w-[280px] items-center justify-center rounded-[24px] border border-[var(--line)] bg-white p-3">
          {qrImage ? <img src={qrImage} alt="QR Code" className="block h-[260px] w-[260px] rounded-xl" /> : <div className="flex h-[260px] w-[260px] items-center justify-center rounded-xl bg-[var(--muted)] text-sm text-[var(--text-muted)]">جارٍ توليد الرمز...</div>}
        </div>
        {qrUrl ? <div className="break-all rounded-2xl bg-[var(--muted)] px-4 py-3 text-left text-xs text-[var(--text-muted)]" dir="ltr">{qrUrl.split('?')[0]}</div> : null}
        <Button type="button" variant="secondary" className="w-full" onClick={closeQrDialog}>
          إغلاق
        </Button>
      </div>
    </Dialog>
  )
}
