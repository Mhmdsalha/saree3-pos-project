import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { publishNotice } from '@/lib/notice-center'
import type { PrintableBarcodeResponse } from '@/types/api'
import {
  BARCODE_PRINT_MAX_QUANTITY,
  type BarcodePrintTarget,
  buildBarcodeSvgMarkup,
  closeBarcodePrintTarget,
  createBarcodePrintTarget,
  printBarcodeLabels,
  validateBarcodePrintQuantity,
} from './print-barcodes'

type BarcodePrintDialogProps = {
  open: boolean
  onClose: () => void
  productName: string
  initialBarcode?: string | null
  initialUnit?: string | null
  initialPrice?: number | null
  title?: string
  description?: string
  printLabel?: string
  onResolveBarcode: () => Promise<PrintableBarcodeResponse | { barcode: string; product_name?: string; unit?: string | null; price?: number | null }>
  onPrinted?: () => void
}

const QUICK_QUANTITIES = [1, 5, 10, 20]

export function BarcodePrintDialog({
  open,
  onClose,
  productName,
  initialBarcode,
  initialUnit,
  initialPrice,
  title = 'طباعة باركود المنتج',
  description = 'اختر عدد النسخ ثم اطبع ملصقات الباركود لنفس المنتج.',
  printLabel = 'طباعة الباركود',
  onResolveBarcode,
  onPrinted,
}: BarcodePrintDialogProps) {
  const [quantity, setQuantity] = useState('1')
  const [isPrinting, setIsPrinting] = useState(false)

  useEffect(() => {
    if (open) {
      setQuantity('1')
      setIsPrinting(false)
    }
  }, [open])

  const previewBarcode = useMemo(() => {
    const value = String(initialBarcode || '').trim()
    return /^\d{13}$/.test(value) ? value : ''
  }, [initialBarcode])

  const previewSvg = useMemo(() => {
    if (!previewBarcode) return ''
    return buildBarcodeSvgMarkup(previewBarcode)
  }, [previewBarcode])

  const handlePrint = async () => {
    const validation = validateBarcodePrintQuantity(quantity)
    if (!validation.ok) {
      publishNotice(validation.message, 'error')
      return
    }

    setIsPrinting(true)
    let printTarget: BarcodePrintTarget | undefined
    try {
      printTarget = createBarcodePrintTarget()
      const resolved = await onResolveBarcode()
      const resolvedBarcode = String(resolved.barcode || '').trim()
      if (!/^\d{13}$/.test(resolvedBarcode)) {
        throw new Error('تعذر تجهيز باركود صالح للطباعة.')
      }

      printBarcodeLabels(
        {
          productName: resolved.product_name || productName,
          barcode: resolvedBarcode,
          unit: resolved.unit ?? initialUnit,
          price: resolved.price ?? initialPrice,
        },
        validation.quantity,
        printTarget,
      )
      publishNotice(`تم تجهيز ${validation.quantity} نسخة للطباعة.`, 'success')
      onPrinted?.()
      onClose()
    } catch (error) {
      closeBarcodePrintTarget(printTarget)
      publishNotice(error instanceof Error ? error.message : 'تعذر طباعة الباركود.', 'error')
    } finally {
      setIsPrinting(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-xl">
      <div className="space-y-5">
        <div className="space-y-1">
          <div className="text-2xl font-black">{title}</div>
          <div className="text-sm text-[var(--text-muted)]">{description}</div>
        </div>

        <Card variant="glass-subtle" className="space-y-3 rounded-[24px] p-4">
          <div className="text-sm font-bold text-[var(--text-muted)]">المنتج</div>
          <div className="text-lg font-black">{productName}</div>
          {previewSvg ? (
            <div className="rounded-[20px] border border-[var(--line)] bg-white px-4 py-4">
              <div className="mx-auto max-w-[260px]" dangerouslySetInnerHTML={{ __html: previewSvg }} />
            </div>
          ) : (
            <div className="rounded-[20px] border border-dashed border-[var(--line)] bg-white px-4 py-4 text-sm text-[var(--text-muted)]">
              سيتم استخدام أو إنشاء باركود داخلي ثابت عند بدء الطباعة.
            </div>
          )}
          {previewBarcode ? <div className="text-center font-mono text-sm">{previewBarcode}</div> : null}
        </Card>

        <div className="space-y-3">
          <div className="text-sm font-bold text-[var(--text-muted)]">عدد النسخ</div>
          <div className="grid grid-cols-4 gap-2">
            {QUICK_QUANTITIES.map((preset) => (
              <Button
                key={preset}
                type="button"
                variant={Number(quantity) === preset ? 'default' : 'secondary'}
                onClick={() => setQuantity(String(preset))}
              >
                {preset}
              </Button>
            ))}
          </div>
          <Input
            type="number"
            min={1}
            max={BARCODE_PRINT_MAX_QUANTITY}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            placeholder="عدد النسخ"
          />
          <div className="text-xs text-[var(--text-muted)]">يمكنك طباعة من 1 إلى {BARCODE_PRINT_MAX_QUANTITY} نسخة في العملية الواحدة.</div>
        </div>

        <div className="flex gap-3">
          <Button type="button" className="flex-1" onClick={() => void handlePrint()} disabled={isPrinting}>
            {isPrinting ? 'جارٍ تجهيز الطباعة...' : printLabel}
          </Button>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose} disabled={isPrinting}>
            إلغاء
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
