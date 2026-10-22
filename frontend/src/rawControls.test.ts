import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { RawControls, RAW_DEBOUNCE_MS } from './rawControls';
import * as api from './rawApi';
import { rawSettings } from './test/rawSettings';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(), setRawControls: vi.fn(), readRawSettings: vi.fn() }));
const initial = () => rawSettings({ workspaceId: 'workspace', handle: 'document', assetId: 'raw', generation: 1, documentToken: 'token', revision: 1 });
let owner: Promise<void>, changed: Mock<() => void>, preview: Mock<(settings: api.RawSettings, current: () => boolean) => Promise<void>>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function controller() {
  return new RawControls(initial(), { schedule: action => { owner = owner.then(action); }, changed, preview });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); owner = Promise.resolve(); changed = vi.fn(); preview = vi.fn(async () => {});
  vi.mocked(api.setRawControls).mockImplementation(async (doc, values) => ({ ...initial(), ...doc, revision: doc.revision + 1,
    values: { ...(doc as api.RawSettings).values, ...values } }));
  vi.mocked(api.readRawSettings).mockImplementation(async doc => ({ ...initial(), ...doc }));
});
afterEach(() => vi.useRealTimers());

it('debounces all C2 controls, flushes the final input and uses readback rather than sent values', async () => {
  const c = controller();
  for (const id of api.RAW_CONTROL_IDS) c.change({ [id]: id === 'wb.temp' ? 5500 : 1 });
  await vi.advanceTimersByTimeAsync(RAW_DEBOUNCE_MS - 1); expect(api.setRawControls).not.toHaveBeenCalled();
  vi.mocked(api.setRawControls).mockResolvedValueOnce({ ...initial(), revision: 2, values: { ...initial().values, 'light.exposure': .9 } });
  c.flush(); await flush(); await owner;
  expect(Object.keys(vi.mocked(api.setRawControls).mock.calls[0][1])).toEqual([...api.RAW_CONTROL_IDS]);
  expect(c.confirmed.values['light.exposure']).toBe(.9); expect(c.desired).toEqual({});
  expect(preview).toHaveBeenCalledOnce(); expect(c.unsettled).toBe(false);
});

it('keeps only the latest unsent values behind one mutation and skips intermediate Preview', async () => {
  const c = controller(), gate = deferred<api.RawSettings>();
  vi.mocked(api.setRawControls).mockReturnValueOnce(gate.promise);
  c.change({ 'light.exposure': 1 }); c.flush(); await flush();
  c.change({ 'light.exposure': 2 }); c.change({ 'light.exposure': 3, 'color.vibrance': 20 }); c.flush();
  expect(api.setRawControls).toHaveBeenCalledOnce();
  gate.resolve({ ...initial(), revision: 2 }); await flush(); await owner;
  expect(api.setRawControls).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.setRawControls).mock.calls[1][0].revision).toBe(2);
  expect(vi.mocked(api.setRawControls).mock.calls[1][1]).toEqual({ 'light.exposure': 3, 'color.vibrance': 20 });
  expect(preview).toHaveBeenCalledOnce(); expect(c.confirmed.values['light.exposure']).toBe(3);
});

it('invalidates a rendering Preview as soon as a newer desired value arrives', async () => {
  const c = controller(), gate = deferred<void>(); let current!: () => boolean;
  preview.mockImplementationOnce(async (_settings, valid) => { current = valid; await gate.promise; });
  c.change({ 'light.exposure': 1 }); c.flush(); await flush(); expect(current()).toBe(true);
  c.change({ 'light.exposure': 2 }); expect(current()).toBe(false);
  gate.resolve(); await flush(); await owner; expect(preview).toHaveBeenCalledTimes(2);
});

it('explicitly resynchronizes a revision conflict before applying the retained desired patch', async () => {
  const c = controller();
  vi.mocked(api.setRawControls).mockRejectedValueOnce(new api.RawApiError('raw_revision_conflict'));
  vi.mocked(api.readRawSettings).mockResolvedValueOnce({ ...initial(), revision: 9 });
  c.change({ 'light.whites': 25 }); c.flush(); await flush(); await owner;
  expect(api.readRawSettings).toHaveBeenCalledOnce();
  expect(vi.mocked(api.setRawControls).mock.calls[1][0].revision).toBe(9);
  expect(c.confirmed.values['light.whites']).toBe(25); expect(c.error).toBeUndefined();
});

it('stops on an unknown mutation outcome until an explicit retry resynchronizes it', async () => {
  const c = controller();
  vi.mocked(api.setRawControls).mockRejectedValueOnce(new Error('timeout'));
  c.change({ 'wb.tint': 10 }); c.flush(); await flush(); await owner;
  expect(c.error).toBe('raw_connection_failed'); expect(preview).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000); expect(api.setRawControls).toHaveBeenCalledOnce();
  vi.mocked(api.readRawSettings).mockResolvedValueOnce({ ...initial(), revision: 5 });
  c.retry(); await flush(); await owner;
  expect(vi.mocked(api.setRawControls).mock.calls[1][0].revision).toBe(5); expect(c.error).toBeUndefined();
});

it('does not publish success or Preview after leaving a document during mutation', async () => {
  const c = controller(), gate = deferred<api.RawSettings>();
  vi.mocked(api.setRawControls).mockReturnValueOnce(gate.promise);
  c.change({ 'color.saturation': 30 }); c.flush(); await flush(); c.dispose(); changed.mockClear();
  gate.resolve({ ...initial(), revision: 2 }); await flush(); await owner;
  expect(changed).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
});
