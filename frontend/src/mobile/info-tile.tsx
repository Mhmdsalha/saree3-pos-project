type InfoTileProps = {
  title: string
  value: string
}

export function InfoTile({ title, value }: InfoTileProps) {
  return (
    <div className="rounded-[20px] border border-[var(--line)] bg-white p-4">
      <div className="text-sm text-[var(--text-muted)]">{title}</div>
      <div className="mt-2 text-xl font-black">{value}</div>
    </div>
  )
}
