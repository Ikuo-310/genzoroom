import { useEffect, useId, useRef } from 'react';
import { isNativeEditingTarget, sliderSteps } from './editShortcuts';

type Props = {
  label: string; value: number; min: number; max: number; step: number; valueText: string;
  onBegin: () => void; onChange: (value: number) => void; onCommit: () => void;
};

export const ADJUSTMENT_KEYBOARD_COMMIT_DELAY_MS = 500;

export function AdjustmentSlider(props: Props) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const hovered = useRef(false);
  const interaction = useRef<'idle' | 'keyboard' | 'pointer'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
      const element = input.current;
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
  return <div className="adjustment-slider">
    <div><label htmlFor={id}>{props.label}</label><output htmlFor={id}>{props.valueText}</output></div>
    <input ref={input} id={id} type="range" min={props.min} max={props.max} step={props.step}
      value={props.value} aria-valuetext={props.valueText}
      onPointerEnter={() => { hovered.current = true; }}
      onPointerLeave={() => { hovered.current = false; }}
      onPointerDown={() => {
        clearTimeout(timer.current);
        interaction.current = 'pointer';
        props.onBegin();
      }}
      onLostPointerCapture={finishPointer}
      onChange={(event) => {
        props.onChange(Number(event.target.value));
        if (interaction.current !== 'pointer') scheduleCommit();
      }} />
  </div>;
}
