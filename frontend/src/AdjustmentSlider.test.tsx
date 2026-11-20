// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AdjustmentSlider } from './AdjustmentSlider';
import i18n from './i18n';
import { I18nextProvider } from 'react-i18next';

let root: Root, host: HTMLDivElement;
function render(onTemporaryPreview?: (active: boolean) => void) {
  const onBegin = vi.fn(), onChange = vi.fn(), onCommit = vi.fn(), onCancel = vi.fn(), onReset = vi.fn();
  root = createRoot(host);
  act(() => root.render(<I18nextProvider i18n={i18n}><AdjustmentSlider adjustmentId="exposure" label="Exposure"
    value={0} min={-5} max={5} step={0.1} valueText="0.0" valueLabel="Exposure value" precision={1}
    defaultValue={0} resetLabel="Reset" enabled onBegin={onBegin} onChange={onChange} onCommit={onCommit}
    onCancel={onCancel} onReset={onReset} onTemporaryPreview={onTemporaryPreview} /></I18nextProvider>));
  return { onCommit, onCancel };
}

afterEach(() => { act(() => root?.unmount()); host?.remove(); });

it('keeps ordinary sliders in their existing pointer interaction across window blur', () => {
  host = document.createElement('div'); document.body.append(host);
  const { onCommit, onCancel } = render();
  const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
  const down = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.assign(down, { button: 0, pointerId: 1, altKey: false });
  act(() => slider.dispatchEvent(down));
  act(() => window.dispatchEvent(new Event('blur')));
  expect(onCommit).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event('pointerup')));
  expect(onCommit).toHaveBeenCalledOnce();
});

it('cancels a temporary-preview slider on window blur and clears its preview', () => {
  host = document.createElement('div'); document.body.append(host);
  const temporaryPreview = vi.fn();
  const { onCancel } = render(temporaryPreview);
  const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
  const down = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.assign(down, { button: 0, pointerId: 2, altKey: true });
  act(() => slider.dispatchEvent(down));
  act(() => window.dispatchEvent(new Event('blur')));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(temporaryPreview.mock.calls).toEqual([[true], [false]]);
});
