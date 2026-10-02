import { useId } from 'react';

export function BinaryRadioChoice({ label, value, onChange, onLabel, offLabel }: {
  label: string; value: boolean; onChange: (value: boolean) => void; onLabel: string; offLabel: string;
}) {
  const name = useId();
  return <div className="binary-radio-choice" role="radiogroup" aria-labelledby={name}>
    <span id={name}>{label}</span>
    <div className="binary-radio-options">
      {[true, false].map(choice => <label key={String(choice)}>
        <input type="radio" name={name} value={String(choice)} checked={value === choice} onChange={() => onChange(choice)} />
        <span>{choice ? onLabel : offLabel}</span>
      </label>)}
    </div>
  </div>;
}
