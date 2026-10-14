type XIconProps = { size?: number };

export function XIcon({ size = 16 }: XIconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>;
}
