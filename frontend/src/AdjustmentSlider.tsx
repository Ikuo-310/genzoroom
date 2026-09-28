import { useEffect, useId, useRef, useState, type CSSProperties, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ADJUSTMENT_IDS, type AdjustmentId } from './editing';
import { isNativeEditingTarget, sliderSteps } from './editShortcuts';
import { adjustmentRowPosition, horizontalAdjustmentTarget, revealAdjustment } from './adjustmentNavigation';
import { useTranslation } from 'react-i18next';
import type { AdjustmentMenuPosition } from './AdjustmentContextMenu';

export type AdjustmentSliderMenuTarget = AdjustmentMenuPosition & { adjustmentId: AdjustmentId };
export type OpenAdjustmentSliderMenu = (target: AdjustmentSliderMenuTarget) => void;

type Props = {
  adjustmentId: AdjustmentId;
  label: string; value: number; min: number; max: number; step: number; valueText: string;
  valueLabel: string; precision: number; defaultValue: number; resetLabel: string;
  enabled: boolean; onToggle: () => void; operationName?: string;
  onOpenContextMenu?: OpenAdjustmentSliderMenu;
  disabled?: boolean;
  trackGradient?: string;
  onBegin: () => void; onChange: (value: number) => void; onCommit: () => void; onReset: () => void;
};

export const ADJUSTMENT_COMMIT_DELAY_MS = 500;
const histogramNumpadCodes = new Set(['Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'NumpadDecimal']);

// Only mounted AdjustmentSliders participate; native ranges elsewhere stay independent.
const adjustments = new Map<HTMLInputElement, () => void>();
let activeAdjustment: HTMLInputElement | null = null;
// Scrolling can emit pointer enter/leave without mouse movement. Keep keyboard ownership until it moves.
let keyboardNavigation = false;
let mousePosition: { x: number; y: number } | null = null;

export function focusAdjustmentCategory() { activeAdjustment = null; }

export function navigateAdjustments(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'defaultPrevented' | 'target' | 'preventDefault'>, current: HTMLElement) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
    || (isNativeEditingTarget(event.target) && !(event.target === current && current.matches('.adjustment-number')))
    || !event.shiftKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return false;
  event.preventDefault();
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  const scope = current.closest('.workspace-side-panel') ?? current.ownerDocument;
  const position = adjustmentRowPosition(current);
  const ordered = Array.from(scope.querySelectorAll<HTMLElement>('.adjustment-category-title, .grading-range-title, .adjustment-range'))
    .filter((item) => !item.closest('[hidden], [inert]') && !item.matches(':disabled')
      && (!(item instanceof HTMLInputElement) || isAvailable(item)));
  const index = position ? ordered.indexOf(position) : -1;
  // A category-disabled row still has an operable individual power button.
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  const adjacent = index >= 0 ? ordered[index + direction] : position
    ? (direction > 0 ? ordered : [...ordered].reverse()).find((item) =>
      !!(position.compareDocumentPosition(item) & (direction > 0 ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING)))
    : undefined;
  const destination = horizontal ? horizontalAdjustmentTarget(current, event.key === 'ArrowRight' ? 1 : -1)
    : adjacent;
  if (destination) {
    focusAdjustmentTarget(destination, !horizontal);
  }
  return true;
}

function focusAdjustmentTarget(destination: HTMLElement, reveal: boolean) {
  const scope = destination.closest('.workspace-side-panel') ?? destination.ownerDocument;
  for (const item of scope.querySelectorAll<HTMLInputElement>('.adjustment-range')) adjustments.get(item)?.();
  keyboardNavigation = true;
  activeAdjustment = destination instanceof HTMLInputElement && destination.matches('.adjustment-range') ? destination : null;
  destination.focus({ preventScroll: true });
  if (reveal) revealAdjustment(destination);
}

export function restoreAdjustmentFocus(panel: HTMLElement, lastId: AdjustmentId | null): boolean {
  const available = Array.from(panel.querySelectorAll<HTMLInputElement>('.adjustment-range')).filter(item => {
    if (!isAvailable(item)) return false;
    for (let node: HTMLElement | null = item; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  });
  const destination = available.find(item => item.dataset.adjustmentId === lastId) ?? available[0];
  if (!destination) return false;
  focusAdjustmentTarget(destination, true);
  return true;
}

function isAvailable(element: HTMLInputElement | null): element is HTMLInputElement {
  return !!element && adjustments.has(element) && element.isConnected
    && !element.matches(':disabled') && !element.closest('[hidden], [inert]');
}

function keyboardAdjustment(): HTMLInputElement | null {
  if (isAvailable(activeAdjustment)) return activeAdjustment;
  const focused = document.activeElement;
  return focused instanceof HTMLInputElement && isAvailable(focused) ? focused : null;
}

function adjustmentIdOf(element: HTMLInputElement | null): AdjustmentId | null {
  if (!isAvailable(element)) return null;
  const id = element.dataset.adjustmentId;
  return ADJUSTMENT_IDS.find((candidate) => candidate === id) ?? null;
}

export function activeAdjustmentId(): AdjustmentId | null {
  return adjustmentIdOf(keyboardAdjustment());
}

function activateFromMouse(element: HTMLInputElement) {
  keyboardNavigation = false;
  activeAdjustment = element;
  const focused = element.ownerDocument.activeElement;
  // Release stale operation focus so Copy and arrows share the hover target, without ending text edits.
  if (focused instanceof HTMLElement && focused !== element
    && ((focused instanceof HTMLInputElement && adjustments.has(focused)) || focused.matches('.adjustment-category-title, .grading-range-title'))) focused.blur();
}

export function AdjustmentSlider(props: Props) {
  const { t } = useTranslation();
  const toggleLabel = t(props.enabled ? 'workspace.disableAdjustment' : 'workspace.enableAdjustment', { name: props.operationName ?? props.label });
  const rangeId = useId();
  const labelId = useId();
  const range = useRef<HTMLInputElement>(null);
  const power = useRef<HTMLButtonElement>(null);
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
    if (navigateAdjustments(event.nativeEvent, event.currentTarget) || event.nativeEvent.isComposing) return;
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
    if (element) adjustments.set(element, () => {
      if (interaction.current === 'keyboard' || interaction.current === 'wheel' || interaction.current === 'pointer') commitAfterInactivity();
    });
    const keydown = (event: KeyboardEvent) => {
      const currentElement = range.current;
      if (!currentElement || keyboardAdjustment() !== currentElement) return;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || isNativeEditingTarget(event.target)) return;
      // NumLock-off keypad keys carry arrow names, but their physical codes belong to ScopePanel.
      if (histogramNumpadCodes.has(event.code)) return;
      if (event.target instanceof HTMLInputElement && event.target.type === 'range' && !adjustments.has(event.target)) return;
      // Outside-panel Shift navigation belongs to the selected operation panel.
      const panel = currentElement.closest('.develop-panel');
      if (panel && event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key)
        && event.target instanceof Node && !panel.contains(event.target)) return;
      if (navigateAdjustments(event, currentElement)) return;
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
      activateFromMouse(element);
      const direction = event.deltaY < 0 ? 1 : -1;
      const steps = event.shiftKey ? 1 : 10;
      let baseValue = current.value;
      if (interaction.current === 'number') {
        baseValue = readDraft() ?? numberStartValue.current ?? current.value;
        commitNumberEdit();
      }
      const value = normalizeValue(baseValue + direction * steps * current.step, current);
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
      if (element) adjustments.delete(element);
      if (activeAdjustment === element) activeAdjustment = null;
      if (adjustments.size === 0) { keyboardNavigation = false; mousePosition = null; }
      clearTimeout(timer.current);
      latest.current.onCommit();
      element?.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('pointerup', pointerEnd);
      window.removeEventListener('pointercancel', pointerEnd);
    };
  }, []);
  return <div className={`adjustment-control${props.enabled ? '' : ' is-bypassed'}`} role="group" aria-labelledby={labelId}
    onContextMenu={(event) => {
      if (!props.onOpenContextMenu || (event.target instanceof Element && event.target.closest('.adjustment-number'))) return;
      event.preventDefault();
      const trigger = range.current && !range.current.disabled ? range.current : power.current;
      if (trigger) props.onOpenContextMenu({ adjustmentId: props.adjustmentId, trigger, x: event.clientX, y: event.clientY });
    }}>
    <label id={labelId} htmlFor={rangeId} title={props.label}>{props.label}</label>
    <input ref={range} id={rangeId} data-adjustment-id={props.adjustmentId} className={props.trackGradient ? "adjustment-range has-gradient" : "adjustment-range"} type="range"
      style={props.trackGradient ? { "--adjustment-track-gradient": props.trackGradient } as CSSProperties : undefined} min={props.min} max={props.max} step={props.step}
      value={props.value} aria-valuetext={props.valueText} disabled={props.disabled}
      onPointerEnter={(event) => {
        hovered.current = true;
        if (!keyboardNavigation && isAvailable(range.current)) activateFromMouse(range.current);
        if (!keyboardNavigation) mousePosition = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        const moved = mousePosition ? mousePosition.x !== event.clientX || mousePosition.y !== event.clientY
          : !keyboardNavigation || !!event.movementX || !!event.movementY;
        mousePosition = { x: event.clientX, y: event.clientY };
        if (moved && isAvailable(range.current)) activateFromMouse(range.current);
      }}
      onPointerLeave={() => {
        hovered.current = false;
        if (activeAdjustment === range.current && document.activeElement !== range.current) activeAdjustment = null;
      }}
      onFocus={() => { activeAdjustment = range.current; }}
      onKeyDown={(event) => {
        if (keyboardAdjustment() === event.currentTarget) navigateAdjustments(event.nativeEvent, event.currentTarget);
      }}
      onBlur={() => {
        if (!hovered.current && activeAdjustment === range.current) activeAdjustment = null;
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        keyboardNavigation = false;
        if (isAvailable(range.current)) activeAdjustment = range.current;
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
        onFocus={() => { focusAdjustmentCategory(); beginNumberEdit(); updateDraft(formatNumber(latest.current.value)); }}
        onChange={changeNumber} onKeyDown={handleNumberKeyDown} onBlur={commitNumberEdit} />
      <button ref={power} type="button" className={`adjustment-category-icon adjustment-power${props.enabled ? '' : ' is-off'}`}
        aria-pressed={props.enabled} aria-label={toggleLabel} title={toggleLabel}
        onFocus={focusAdjustmentCategory} onKeyDown={(event) => { navigateAdjustments(event.nativeEvent, event.currentTarget); }}
        onClick={props.onToggle}>⏻</button>
      <button type="button" className="adjustment-reset" onClick={props.onReset}
        onFocus={focusAdjustmentCategory}
        onKeyDown={(event) => { navigateAdjustments(event.nativeEvent, event.currentTarget); }}
        disabled={props.disabled || props.value === props.defaultValue} aria-label={props.resetLabel} title={props.resetLabel}>↺</button>
    </div>
  </div>;
}

function normalizeValue(value: number, props: Pick<Props, 'min' | 'max' | 'step' | 'precision'>) {
  const stepped = props.min + Math.round((value - props.min) / props.step) * props.step;
  return Number(Math.max(props.min, Math.min(props.max, stepped)).toFixed(props.precision));
}
