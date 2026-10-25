// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RawRegionDiagnostics } from './RawRegionDiagnosticsPanel';
import { diagnosticVisibleRect, RAW_REGION_DIAGNOSTICS_CHANNEL, type RawRegionDiagnosticMessage,
  type RawRegionDiagnosticState, type RawRegionPosition } from './rawRegionDiagnostics';
import i18n from './i18n';

const channels = new Set<TestChannel>();
const posted: RawRegionDiagnosticMessage[] = [];
class TestChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) { channels.add(this); }
  postMessage(message: RawRegionDiagnosticMessage) {
    posted.push(message);
    for (const target of channels) if (target !== this && target.name === this.name) target.onmessage?.({ data: message } as MessageEvent);
  }
  close() { channels.delete(this); }
}
let host: HTMLDivElement, root: Root, owner: TestChannel, clientId: string;
const baseState: RawRegionDiagnosticState = { connected: true, supported: true, wholeQuality: 'full', wholeGeometry: 'geometry',
  regionGeometry: null, geometryMatches: null, regionSize: null, displayed: false, beforeReady: false,
  comparing: false, position: null, requesting: false, cleared: true, frame: { nativeWidth: 4000, nativeHeight: 3000 }, details: null };
function send(message: RawRegionDiagnosticMessage) { owner.postMessage(message); }
function state(value: RawRegionDiagnosticState) { send({ type: 'state', clientId, ownerId: 'owner', state: value }); }
async function render(active = true) { await act(async () => root.render(<RawRegionDiagnostics active={active} />)); }
async function click(label: string) { await act(async () => host.querySelectorAll('button').forEach(button => { if (button.textContent === label) button.click(); })); }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('BroadcastChannel', TestChannel);
  posted.length = 0; channels.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  owner = new TestChannel(RAW_REGION_DIAGNOSTICS_CHANNEL);
  await render(); clientId = posted.find(message => message.type === 'attach')!.clientId;
});
afterEach(() => { act(() => root.unmount()); owner.close(); host.remove(); channels.clear(); vi.unstubAllGlobals(); });

it('calculates fixed half-frame diagnostic rectangles for the center, corners and edges', () => {
  const expected: Record<RawRegionPosition, [number, number]> = { center: [1000, 750], topLeft: [0, 0], topRight: [2000, 0],
    bottomLeft: [0, 1500], bottomRight: [2000, 1500], left: [0, 750], right: [2000, 750], top: [1000, 0], bottom: [1000, 1500] };
  for (const [position, [x0, y0]] of Object.entries(expected) as [RawRegionPosition, [number, number]][]) {
    expect(diagnosticVisibleRect(position, 4000, 3000)).toEqual({ x0, y0, x1: x0 + 2000, y1: y0 + 1500 });
  }
});

it('shows disconnected, unsupported and Whole waiting states without sending a Region request', async () => {
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.status.notConnected'));
  state({ ...baseState, connected: true, supported: false }); await render();
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.errors.capability'));
  expect(host.querySelector<HTMLButtonElement>('.raw-region-position-buttons button')!.disabled).toBe(true);
  state({ ...baseState, connected: true, supported: true, wholeQuality: 'draft' }); await render();
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.errors.wholeWaiting'));
  expect(posted.filter(message => message.type === 'action' && message.action === 'request')).toHaveLength(0);
});

it('keeps null capability in Checking and enables positions only after a supported owner response', async () => {
  state({ ...baseState, supported: null }); await render();
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.status.checking'));
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.capability.checking'));
  expect(host.textContent).not.toContain(i18n.t('rawRegionDiagnostics.status.ready'));
  expect([...host.querySelectorAll('button')].find(button => button.textContent === i18n.t('rawRegionDiagnostics.positions.center'))!.disabled).toBe(true);

  state({ ...baseState, supported: true }); await render();
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.capability.supported'));
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.status.ready'));
  expect([...host.querySelectorAll('button')].find(button => button.textContent === i18n.t('rawRegionDiagnostics.positions.center'))!.disabled).toBe(false);
});

it('reports a failed Region owner lookup distinctly from unsupported capability', async () => {
  state({ ...baseState, supported: null, errorCode: 'raw_region_owner_failed', ownerErrorCode: 'raw_invalid_response', ownerHttpStatus: 200 }); await render();
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.status.ownerFailed'));
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.capability.ownerFailed'));
  expect(host.querySelector('[role=alert]')?.textContent).toContain(i18n.t('rawRegionDiagnostics.errors.ownerFailed'));
  expect(host.querySelector('[role=alert]')?.textContent).toContain('raw_invalid_response / HTTP 200');
  expect([...host.querySelectorAll('button')].find(button => button.textContent === i18n.t('rawRegionDiagnostics.positions.center'))!.disabled).toBe(true);
  state(baseState); await render();
  expect(host.querySelector('[role=alert]')).toBeNull();
  expect([...host.querySelectorAll('button')].find(button => button.textContent === i18n.t('rawRegionDiagnostics.positions.center'))!.disabled).toBe(false);
});

it('shows adopted overlay quality, geometry agreement, bitmap size and clear state in plain language', async () => {
  const displayed: RawRegionDiagnosticState = { ...baseState, wholeQuality: 'draft', regionGeometry: 'geometry',
    geometryMatches: true, regionSize: { width: 1024, height: 768 }, displayed: true, cleared: false,
    details: { f: { fullWidth: 2048, fullHeight: 1536 }, w: { x: 128, y: 96, w: 512, h: 384 },
      validRegion: { x: 144, y: 112, w: 480, h: 352 }, revision: 7, viewGeneration: 9, planGeneration: 10, requestId: 'request' } };
  state(displayed); await render();
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.status.displaying'));
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.qualities.draft'));
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.match'));
  expect(host.textContent).toContain('1024 × 768');
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.no'));
});

it('issues center, corner, and edge requests and clears Region through explicit button actions', async () => {
  state(baseState); await render();
  const outline = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].at(-1)!;
  expect(outline.checked).toBe(false);
  await act(async () => { outline.click(); });
  expect(posted.at(-1)).toMatchObject({ type: 'action', action: 'outline', enabled: true });
  for (const position of ['center', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'left', 'right', 'top', 'bottom'] as const) {
    await click(i18n.t(`rawRegionDiagnostics.positions.${position}`));
    const request = posted.filter((message): message is Extract<RawRegionDiagnosticMessage, { type: 'action' }> => message.type === 'action' && message.action === 'request').at(-1);
    expect(request).toMatchObject({ action: 'request', position, compare: false });
    send({ type: 'result', clientId, ownerId: 'owner', actionId: request!.actionId, ok: true }); await render();
  }
  await click(i18n.t('rawRegionDiagnostics.clear'));
  expect(posted.at(-1)).toMatchObject({ type: 'action', action: 'clear' });
});

it('does not submit comparison before Before is ready, then sends a paired request and displays human-readable failure', async () => {
  state(baseState); await render();
  const checkbox = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  await act(async () => { checkbox.click(); });
  expect(host.textContent).toContain(i18n.t('rawRegionDiagnostics.errors.beforeWaiting'));
  expect([...host.querySelectorAll('button')].find(button => button.textContent === i18n.t('rawRegionDiagnostics.positions.center'))!.disabled).toBe(true);
  expect(posted.filter(message => message.type === 'action' && message.action === 'request')).toHaveLength(0);
  state({ ...baseState, beforeReady: true }); await render();
  await click(i18n.t('rawRegionDiagnostics.positions.center'));
  const request = posted.filter((message): message is Extract<RawRegionDiagnosticMessage, { type: 'action' }> => message.type === 'action' && message.action === 'request').at(-1)!;
  expect(request).toMatchObject({ action: 'request', position: 'center', compare: true });
  send({ type: 'result', clientId, ownerId: 'owner', actionId: request.actionId, ok: false, errorCode: 'raw_region_decode_failed' }); await render();
  expect(host.querySelector('[role=alert]')?.textContent).toContain(i18n.t('rawRegionDiagnostics.errors.requestFailed'));
  expect(host.textContent).not.toContain('rawRegionDiagnostics.');
});

it('detaches when the Developer Diagnostics section is closed or unmounted', async () => {
  await render(false);
  expect(posted.at(-1)).toMatchObject({ type: 'detach' });
  await render(true);
  act(() => root.unmount()); root = createRoot(host);
  expect(posted.at(-1)).toMatchObject({ type: 'detach' });
});

it('offers provisional density evidence and same-view automatic/Whole-only controls without manual coordinates', async () => {
  state({ ...baseState, auto: { enabled: true, active: true, decision: 'region_reuse', reason: 'cached_valid_region',
    viewGeneration: 8, wholeBitmap: { width: 2048, height: 1536 }, wholeF: { width: 2048, height: 1536 },
    regionBitmap: { width: 512, height: 512 }, regionF: { width: 4000, height: 3000 }, dpr: 1.25, scale: .8,
    wholeDensity: .512, requiredDensity: 1, regionDensity: 1, rho: .512, quality: 'full', lastPlan: 'reuse' } }); await render();
  expect(host.textContent).toContain('2048 × 1536'); expect(host.textContent).toContain('4000 × 3000');
  expect(host.textContent).toContain('0.512'); expect(host.textContent).toContain('C2-C provisional');
  await click(i18n.t('rawRegionDiagnostics.wholeOnly'));
  expect(posted.at(-1)).toMatchObject({ action: 'auto', enabled: false, ownerId: 'owner' });
  await click(i18n.t('rawRegionDiagnostics.autoEnable'));
  expect(posted.at(-1)).toMatchObject({ action: 'auto', enabled: true, ownerId: 'owner' });
});
