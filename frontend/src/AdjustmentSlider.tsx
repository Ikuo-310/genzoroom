import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { isNativeEditingTarget, sliderSteps } from './editShortcuts';

type Props = {
  label: string; value: number; min: number; max: number; step: number; valueText: string;
  valueLabel: string; unit?: string; precision: number; defaultValue: number; resetLabel: string;
  onBegin: () => void; onChange: (value: number) => void; onCommit: () => void; onReset: () => void;
};

export const ADJUSTMENT_KEYBOARD_COMMIT_DELAY_MS = 500;

export function AdjustmentSlider(props: Props) {
  const rangeId = useId();
  const labelId = useId();
  const range = useRef<HTMLInputElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const hovered = useRef(false);
  const interaction = useRef<'idle' | 'keyboard' | 'pointer' | 'number'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const numberStartValue = useRef<number | null>(null);
  const [numberEditing, setNumberEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  function formatNumber(value: number) {
    return value.toFixed(props.precision);
  }

  function normalizeNumber(value: number) {
    const stepped = props.min + Math.round((value - props.min) / props.step) * props.step;
    return Number(Math.max(props.min, Math.min(props.max, stepped)).toFixed(props.precision));
  }

  function readDraft() {
    if (draft === null || draft.trim() === '') return null;
    const value = Number(draft);
    return Number.isFinite(value) ? normalizeNumber(value) : null;
  }

  function beginNumberEdit() {
    clearTimeout(timer.current);
    if (interaction.current !== 'number') {
      interaction.current = 'number';
      numberStartValue.current = latest.current.value;
      latest.current.onBegin();
      setNumberEditing(true);
    }
  }

  function commitNumberEdit() {
    if (interaction.current !== 'number') return;
    const value = readDraft();
    latest.current.onChange(value ?? numberStartValue.current ?? latest.current.value);
    latest.current.onCommit();
    interaction.current = 'idle';
    numberStartValue.current = null;
    setNumberEditing(false);
    setDraft(null);
  }

  function cancelNumberEdit() {
    if (interaction.current !== 'number') return;
    latest.current.onChange(numberStartValue.current ?? latest.current.value);
    latest.current.onCommit();
    interaction.current = 'idle';
    numberStartValue.current = null;
    setNumberEditing(false);
    setDraft(null);
  }

  function changeNumber(event: ChangeEvent<HTMLInputElement>) {
    beginNumberEdit();
    const nextDraft = event.target.value;
    setDraft(nextDraft);
    if (nextDraft.trim() === '') return;
    const value = Number(nextDraft);
    if (Number.isFinite(value)) latest.current.onChange(normalizeNumber(value));
  }

  function handleNumberKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitNumberEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelNumberEdit();
    }
  }

  function commitKeyboardAfterInactivity() {
    clearTimeout(timer.current);
    interaction.current = 'idle';
    latest.current.onCommit();
  }
  function scheduleCommit() {
    clearTimeout(timer.current);
    interaction.current = 'keyboard';
    timer.current = setTimeout(commitKeyboardAfterInactivity, ADJUSTMENT_KEYBOARD_COMMIT_DELAY_MS);
  }
  function finishPointer() {
    if (interaction.current !== 'pointer') return;
    interaction.current = 'idle';
    latest.current.onCommit();
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const element = range.current;
      if (!element || (!hovered.current && document.activeElement !== element) || element.closest('[hidden]')) return;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || isNativeEditingTarget(event.target)) return;
      // A focused different slider keeps its own keyboard behavior.
      if (event.target instanceof HTMLInputElement && event.target.type === 'range' && event.target !== element) return;
      const steps = sliderSteps(event.key);
      if (steps === undefined) return;
      event.preventDefault();
      const current = latest.current;
      current.onBegin();
      const value = Math.max(current.min, Math.min(current.max, Math.round((current.value + steps * current.step) / current.step) * current.step));
      current.onChange(value);
      scheduleCommit();
    };
    const pointerEnd = () => finishPointer();
    window.addEventListener('keydown', keydown);
    window.addEventListener('pointerup', pointerEnd);
    window.addEventListener('pointercancel', pointerEnd);
    return () => {
      clearTimeout(timer.current);
      latest.current.onCommit();
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('pointerup', pointerEnd);
      window.removeEventListener('pointercancel', pointerEnd);
    };
  }, []);
  return <div className="adjustment-control" role="group" aria-labelledby={labelId}>
    <label id={labelId} htmlFor={rangeId} title={props.label}>{props.label}</label>
    <input ref={range} id={rangeId} className="adjustment-range" type="range" min={props.min} max={props.max} step={props.step}
      value={props.value} aria-valuetext={props.valueText}
      onPointerEnter={() => { hovered.current = true; }}
      onPointerLeave={() => { hovered.current = false; }}
      onPointerDown={() => {
        clearTimeout(timer.current);
        if (interaction.current === 'number') commitNumberEdit();
        interaction.current = 'pointer';
        props.onBegin();
      }}
      onLostPointerCapture={finishPointer}
      onChange={(event) => {
        props.onChange(Number(event.target.value));
        if (interaction.current !== 'pointer') scheduleCommit();
      }} />
    <div className="adjustment-value-controls">
      <input className="adjustment-number" type="number" min={props.min} max={props.max} step={props.step}
        value={numberEditing && draft !== null ? draft : formatNumber(props.value)} aria-label={props.valueLabel}
        onFocus={() => { beginNumberEdit(); setDraft(formatNumber(latest.current.value)); }}
        onChange={changeNumber} onKeyDown={handleNumberKeyDown} onBlur={commitNumberEdit} />
      {props.unit && <span className="adjustment-unit" aria-hidden="true">{props.unit}</span>}
      <button type="button" className="adjustment-reset" onClick={props.onReset}
        disabled={props.value === props.defaultValue} aria-label={props.resetLabel} title={props.resetLabel}>↺</button>
    </div>
  </div>;
}
