import type { ReactNode, SelectHTMLAttributes } from 'react';

type HomeToolbarSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'value'> & {
  value: string | number;
  selectedLabel: string;
  children: ReactNode;
};

export function HomeToolbarSelect({ value, selectedLabel, children, ...selectProps }: HomeToolbarSelectProps) {
  const selectedValue = String(value);

  return (
    <span className="home-select-shell">
      <select className="home-select-interactive" {...selectProps} value={selectedValue}>{children}</select>
      <select className="home-select-sizing" aria-hidden="true" tabIndex={-1} value={selectedValue} onChange={() => {}}>
        <option value={selectedValue}>{selectedLabel}</option>
      </select>
    </span>
  );
}
