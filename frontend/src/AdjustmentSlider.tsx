import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { isNativeEditingTarget, sliderSteps } from './editShortcuts';

type Props = {
  label: string; value: number; min: number; max: number; step: number; valueText: string;
  valueLabel: string; unit?: string; precision: number; defaultValue: number; resetLabel: string;
  disabled?: boolean;
  onBegin: () => void; onChange: (value: number) => void; onCommit: () => void; onReset: () => void;
};

export const ADJUSTMENT_COMMIT_DELAY_MS = 500;

export function AdjustmentSlider(props: Props) {
  const rangeId = useId();
  const labelId = useId();
  const range = useRef<HTMLInputElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const hovered = useRef(false);
  const interaction = useRef<'idle' | 'keyboard' | 'wheel' | 'pointer' | 'number'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const numberStartValue = useRef<number | null>(null);
  const draftValue = useRef<string | null>(null);
  const [numberEditing, setNumberEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  function formatNumber(value: number) {
    return value.toFixed(props.precision);
  }

  function normalizeNumber(value: number) {
    return normalizeValue(value, props);
  }

  function readDraft() {
    if (draftValue.current === null || draftValue.current.trim() === '') return null;
    const value = Number(draftValue.current);
    return Number.isFinite(value) ? normalizeNumber(value) : null;
  }

  function updateDraft(value: string | null) {
    draftValue.current = value;
    setDraft(value);
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
    updateDraft(null);
  }

  function cancelNumberEdit() {
    if (interaction.current !== 'number') return;
    latest.current.onChange(numberStartValue.current ?? latest.current.value);
    latest.current.onCommit();
    interaction.current = 'idle';
    numberStartValue.current = null;
    setNumberEditing(false);
    updateDraft(null);
  }

  function changeNumber(event: ChangeEvent<HTMLInputElement>) {
    beginNumberEdit();
    const nextDraft = event.target.value;
    updateDraft(nextDraft);
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

  function commitAfterInactivity() {
    clearTimeout(timer.current);
    interaction.current = 'idle';
    latest.current.onCommit();
  }
  function scheduleCommit(kind: 'keyboard' | 'wheel' = 'keyboard') {
    clearTimeout(timer.current);
    interaction.current = kind;
    timer.current = setTimeout(commitAfterInactivity, ADJUSTMENT_COMMIT_DELAY_MS);
  }
  function finishPointer() {
    if (interaction.current !== 'pointer') return;
    interaction.current = 'idle';
    latest.current.onCommit();
  }
  useEffect(() => {
    const element = range.current;
    const keydown = (event: KeyboardEvent) => {
      const currentElement = range.current;
      if (!currentElement || currentElement.disabled || (!hovered.current && document.activeElement !== currentElement) || currentElement.closest('[hidden]')) return;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || isNativeEditingTarget(event.target)) return;
      // A focused different slider keeps its own keyboard behavior.
      if (event.target instanceof HTMLInputElement && event.target.type === 'range' && event.target !== currentElement) return;
      const steps = sliderSteps(event.key);
      if (steps === undefined) return;
      event.preventDefault();
      const current = latest.current;
      current.onBegin();
      const value = Math.max(current.min, Math.min(current.max, Math.round((current.value + steps * current.step) / current.step) * current.step));
      current.onChange(value);
      scheduleCommit();
    };
    const wheel = (event: WheelEvent) => {
      const current = latest.current;
      if (!element || element.disabled || event.deltaY === 0) return;
      const direction = event.deltaY < 0 ? 1 : -1;
      let baseValue = current.value;
      if (interaction.current === 'number') {
        baseValue = readDraft() ?? numberStartValue.current ?? current.value;
        commitNumberEdit();
      }
      const value = normalizeValue(baseValue + direction * current.step, current);
      if (value === current.value) return;
      event.preventDefault();
      current.onBegin();
      current.onChange(value);
      scheduleCommit('wheel');
    };
    const pointerEnd = () => finishPointer();
    element?.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', keydown);
    window.addEventListener('pointerup', pointerEnd);
    window.addEventListener('pointercancel', pointerEnd);
    return () => {
      clearTimeout(timer.current);
      latest.current.onCommit();
      element?.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('pointerup', pointerEnd);
      window.removeEventListener('pointercancel', pointerEnd);
    };
  }, []);
  return <div className="adjustment-control" role="group" aria-labelledby={labelId}>
    <label id={labelId} htmlFor={rangeId} title={props.label}>{props.label}</label>
    <input ref={range} id={rangeId} className="adjustment-range" type="range" min={props.min} max={props.max} step={props.step}
      value={props.value} aria-valuetext={props.valueText} disabled={props.disabled}
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
        value={numberEditing && draft !== null ? draft : formatNumber(props.value)} aria-label={props.valueLabel} disabled={props.disabled}
        onFocus={() => { beginNumberEdit(); updateDraft(formatNumber(latest.current.value)); }}
        onChange={changeNumber} onKeyDown={handleNumberKeyDown} onBlur={commitNumberEdit} />
      <span className="adjustment-unit" aria-hidden="true">{props.unit ?? ''}</span>
      <button type="button" className="adjustment-reset" onClick={props.onReset}
        disabled={props.disabled || props.value === props.defaultValue} aria-label={props.resetLabel} title={props.resetLabel}>↺</button>
    </div>
  </div>;
}

function normalizeValue(value: number, props: Pick<Props, 'min' | 'max' | 'step' | 'precision'>) {
  const stepped = props.min + Math.round((value - props.min) / props.step) * props.step;
  return Number(Math.max(props.min, Math.min(props.max, stepped)).toFixed(props.precision));
}
