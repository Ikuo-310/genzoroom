import type { ReactNode, SelectHTMLAttributes } from 'react';

type HomeToolbarSelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  currentLabel: string;
  children: ReactNode;
};

export function HomeToolbarSelect({ currentLabel, children, ...selectProps }: HomeToolbarSelectProps) {
  return (
    <span className="home-select-shell">
      <span className="home-select-measure" aria-hidden="true">{currentLabel}</span>
      <select {...selectProps}>{children}</select>
    </span>
  );
}
