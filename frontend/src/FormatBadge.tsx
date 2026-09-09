export function FormatBadge({ format, isRaw }: { format: string; isRaw: boolean }) {
  return <span className={`format-badge${isRaw ? ' raw' : ''}`}>{format}</span>;
}
