// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePhotoSelection } from './usePhotoSelection';

let host: HTMLDivElement;
let root: Root;
let selection: ReturnType<typeof usePhotoSelection>;

function Harness() {
  selection = usePhotoSelection();
  return <output>{JSON.stringify(selection.selectedIds)}</output>;
}

function selected() { return JSON.parse(host.querySelector('output')!.textContent!) as string[]; }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('usePhotoSelection', () => {
  it('selects only one asset and sets it as the range anchor', () => {
    act(() => { selection.toggle('a'); selection.selectOnly('c'); });
    expect(selected()).toEqual(['c']);
    act(() => selection.extendRange('d', ['a', 'b', 'c', 'd']));
    expect(selected()).toEqual(['c', 'd']);
  });

  it('toggles while preserving other assets and uses the toggled asset as the next anchor', () => {
    act(() => { selection.selectOnly('a'); selection.toggle('b'); });
    expect(selected()).toEqual(['a', 'b']);
    act(() => selection.toggle('b'));
    expect(selected()).toEqual(['a']);
    act(() => selection.extendRange('d', ['a', 'b', 'c', 'd']));
    expect(selected()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clears the anchor when the last asset is toggled off and ignores a range without an anchor', () => {
    act(() => { selection.selectOnly('a'); selection.toggle('a'); });
    expect(selected()).toEqual([]);
    act(() => selection.extendRange('c', ['a', 'b', 'c']));
    expect(selected()).toEqual([]);
  });

  it('adds visible assets without dropping hidden selection and clear resets both selection and anchor', () => {
    act(() => { selection.selectOnly('hidden'); selection.selectVisible(['a', 'b']); });
    expect(selected()).toEqual(['hidden', 'a', 'b']);
    act(() => selection.clear());
    expect(selected()).toEqual([]);
    act(() => selection.extendRange('b', ['a', 'b']));
    expect(selected()).toEqual([]);
  });

  it('retains only available selected assets and clears a removed anchor', () => {
    act(() => { selection.selectOnly('gone'); selection.toggle('keep'); });
    act(() => selection.retainAvailable(new Set(['keep', 'a', 'b'])));
    expect(selected()).toEqual(['keep']);
    act(() => selection.extendRange('b', ['a', 'b']));
    expect(selected()).toEqual(['keep']);
  });
});
