import { useEffect, useId, useRef } from 'react';
import { isNativeEditingTarget, sliderSteps } from './editShortcuts';

type Props = {
  label: string; value: number; min: number; max: number; step: number; valueText: string;
  onBegin: () => void; onChange: (value: number) => void; onCommit: () => void;
};

export function AdjustmentSlider(props: Props) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const hovered = useRef(false);
  const dragging = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function finish() {
    clearTimeout(timer.current);
    dragging.current = false;
    latest.current.onCommit();
  }
  function scheduleCommit() {
    clearTimeout(timer.current);
    timer.current = setTimeout(finish, 400);
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
    const pointerEnd = () => { if (dragging.current) finish(); };
    const focusChange = (event: Event) => { if (event.target !== input.current) finish(); };
    window.addEventListener('keydown', keydown);
    window.addEventListener('pointerup', pointerEnd);
    window.addEventListener('pointercancel', pointerEnd);
    window.addEventListener('blur', focusChange);
    document.addEventListener('focusin', focusChange);
    return () => {
      clearTimeout(timer.current);
      latest.current.onCommit();
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('pointerup', pointerEnd);
      window.removeEventListener('pointercancel', pointerEnd);
      window.removeEventListener('blur', focusChange);
      document.removeEventListener('focusin', focusChange);
    };
  }, []);
  return <div className="adjustment-slider">
    <div><label htmlFor={id}>{props.label}</label><output htmlFor={id}>{props.valueText}</output></div>
    <input ref={input} id={id} type="range" min={props.min} max={props.max} step={props.step}
      value={props.value} aria-valuetext={props.valueText}
      onPointerEnter={() => { hovered.current = true; }}
      onPointerLeave={() => { hovered.current = false; if (!dragging.current) finish(); }}
      onPointerDown={() => { clearTimeout(timer.current); dragging.current = true; props.onBegin(); }}
      onLostPointerCapture={() => { if (dragging.current) finish(); }}
      onBlur={finish}
      onChange={(event) => { props.onChange(Number(event.target.value)); if (!dragging.current) scheduleCommit(); }} />
  </div>;
}
