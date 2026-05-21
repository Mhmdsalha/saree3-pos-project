import { Card } from '@/components/ui/card'

type PlaceholderPageProps = {
  title: string
  subtitle: string
}

export function PlaceholderPage({ title, subtitle }: PlaceholderPageProps) {
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4">
      <div>
        <h2 className="text-3xl font-black">{title}</h2>
        <p className="mt-2 text-[var(--text-muted)]">{subtitle}</p>
      </div>
      <Card className="flex min-h-0 items-center justify-center rounded-[28px] border-dashed bg-[var(--muted)]/40 p-8 text-center text-[var(--text-muted)] shadow-none">
        هذا القسم جاهز للترحيل التقني لاحقًا مع الحفاظ على نفس التصميم والسلوك الحاليين.
      </Card>
    </div>
  )
}
