import type { MouseEventHandler } from 'react';

export function HomeTitle({ className, onActivate, disabled = false }: {
  className: string;
  onActivate: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
}) {
  return <button type="button" className={className} onClick={onActivate} disabled={disabled}>GenzoRoom</button>;
}
