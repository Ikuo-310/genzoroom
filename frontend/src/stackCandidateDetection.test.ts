import { describe, expect, it } from 'vitest';
import type { AssetExif, RecentAsset } from './assets';
import { chooseStackCover, detectStackCandidates, filenameFamily, parseStackDate, stackCandidateDetailTargets } from './stackCandidateDetection';
const asset = (id: string, filename: string, raw: boolean, date = '2026-10-01T08:25:49Z'): RecentAsset => ({ id, filename, is_raw: raw, format: raw ? 'DNG' : filename.endsWith('.png') ? 'PNG' : 'JPEG', date, thumbnail_url: `/thumb/${id}` });
const pair = [asset('raw', 'IMG_1234.DNG', true), asset('jpg', 'IMG_1234.JPG', false)];
const evidence = (first: AssetExif, second: AssetExif) => detectStackCandidates(pair, new Map([['raw', first], ['jpg', second]])).groups[0].evidence;
describe('filename candidates', () => {
  it.each([
    ['IMG_1234.JPG', 'IMG_1234.DNG', false, true],
    ['IMG_1234.jpg', 'IMG_1234.jpeg', false, false],
    ['IMG_1234.dng', 'IMG_1234.nef', true, true],
    ['PXL_20260917_051042180.RAW-01.COVER.jpg', 'PXL_20260917_051042180.RAW-02.ORIGINAL.dng', false, true],
    ['PXL_20260917_051042180.RAW-01.MP.COVER.jpg', 'PXL_20260917_051042180.RAW-02.ORIGINAL.dng', false, true],
    ['OtherCamera.arbitrary.variant.jpg', 'OtherCamera.unrecognized.raw.dng', false, true],
    ['IMG_1234-Genzo01.jpg', 'IMG_1234-Genzo02.jpg', false, false],
  ])('groups %s and %s independently of format', (a, b, rawA, rawB) => {
    const members = [asset('a', a, rawA), asset('b', b, rawB)];
    const result = detectStackCandidates(members);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ members, origin: 'auto', evidence: { name: 'matched', nameReason: 'filename-family' } });
    expect(result.unmatched).toEqual([]);
  });
  it('groups originals and multiple Genzo decimal suffixes', () => {
    const members = ['IMG_1234.jpg', 'IMG_1234-Genzo01.jpg', 'IMG_1234-Genzo02.jpg', 'IMG_1234-Genzo12.jpg', 'IMG_1234-Genzo1.jpg', 'IMG_1234-Genzo123.jpg'].map((name, i) => asset(String(i), name, false));
    expect(detectStackCandidates(members).groups[0].members).toEqual(members);
    for (const member of members) expect(filenameFamily(member.filename)).toEqual({ key: 'IMG_1234', reason: 'filename-family' });
    for (const name of ['IMG_1234-Genzo.jpg', 'IMG_1234-genzo01.jpg', 'IMG_1234-Genzo01-more.jpg']) expect(filenameFamily(name)?.key).not.toBe('IMG_1234');
  });
  it('rejects unsafe families and preserves different and case-sensitive roots', () => {
    for (const name of ['', 'IMG_1234', '.jpg', 'IMG_1234.', 'IMG_1234.variant.', '-Genzo01.jpg', ' .jpg']) expect(filenameFamily(name)).toBeNull();
    for (const name of ['img_1234.JPG', 'IMG_1235.JPG']) expect(detectStackCandidates([pair[0], asset('other', name, false)]).groups).toEqual([]);
  });
  it('excludes existing Stack members and leaves singleton or duplicate-only selections unmatched', () => {
    const stacked = { ...pair[0], stackId: 'existing' };
    const result = detectStackCandidates([stacked, pair[1]]);
    expect(result.groups).toEqual([]); expect(result.unmatched).toEqual([stacked, pair[1]]);
    expect(detectStackCandidates([pair[0]]).groups).toEqual([]);
    expect(detectStackCandidates([pair[0], pair[0]]).groups).toEqual([]);
  });
  it('orders groups and members by selection and partitions unique IDs', () => {
    const otherRaw = asset('b-raw', 'B.dng', true), otherJpg = asset('b-jpg', 'B.jpg', false), single = asset('single', 'single.jpg', false);
    const result = detectStackCandidates([otherRaw, pair[1], single, pair[0], otherJpg, pair[0]]);
    expect(result.groups.map(g => g.members.map(a => a.id))).toEqual([['b-raw', 'b-jpg'], ['jpg', 'raw']]); expect(result.unmatched).toEqual([single]);
  });
});

describe('EXIF fallback candidates', () => {
  const exif = (overrides: AssetExif = {}): AssetExif => ({ date_time_original: '2026:10:01 08:25:49', make: 'Camera', model: 'Model', latitude: 35, longitude: 139, ...overrides });
  const members = [asset('a', 'capture.dng', true), asset('b', 'export.jpg', false)];
  const details = (assets: readonly RecentAsset[], overrides: Record<string, AssetExif> = {}) => new Map(assets.map(a => [a.id, overrides[a.id] ?? exif()]));
  it.each([[false, true], [false, false], [true, true], [true, false, false, true]])('groups format composition %j with matched EXIF', (...formats) => {
    const assets = formats.map((raw, i) => asset(String(i), 'different-' + i + (raw ? '.dng' : '.jpg'), raw));
    const result = detectStackCandidates([...assets, assets[0]], details(assets));
    expect(result.groups).toHaveLength(1); expect(result.groups[0]).toMatchObject({ members: assets, evidence: { name: 'mismatch', nameReason: 'exif-fallback', time: 'matched', camera: 'matched', gps: 'matched' } });
    expect(result.unmatched).toEqual([]);
  });
  it.each([
    ['TIME mismatch', exif({ date_time_original: '2026:10:01 08:25:53' })],
    ['TIME missing', exif({ date_time_original: undefined })],
    ['TIME malformed', exif({ date_time_original: 'invalid' })],
    ['CAM mismatch', exif({ model: 'Other' })],
    ['CAM missing make', exif({ make: undefined })],
    ['CAM missing model', exif({ model: undefined })],
    ['CAM malformed', exif({ make: 42 } as unknown as AssetExif)],
    ['GPS mismatch', exif({ latitude: 36 })],
    ['GPS malformed', exif({ latitude: NaN, longitude: undefined })],
  ])('rejects fallback for %s', (_label, other) => {
    const result = detectStackCandidates(members, details(members, { b: other }));
    expect(result.groups).toEqual([]); expect(result.unmatched).toEqual(members);
  });
  it('rejects failed and missing details and existing Stack members', () => {
    expect(detectStackCandidates(members, details(members), new Set(['a'])).groups).toEqual([]);
    expect(detectStackCandidates(members, new Map([['a', exif()]])).groups).toEqual([]);
    expect(detectStackCandidates([{ ...members[0], stackId: 'existing' }, members[1]], details(members)).groups).toEqual([]);
  });
  it('accepts missing GPS and compares available positions even with missing members', () => {
    const assets = [...members, asset('c', 'third.jpg', false)];
    const missing = exif({ latitude: undefined, longitude: undefined });
    expect(detectStackCandidates(assets, new Map(assets.map(a => [a.id, missing]))).groups[0]).toMatchObject({ members: assets, evidence: { gps: 'unavailable' } });
    const partial = details(assets, { b: missing });
    expect(detectStackCandidates(assets, partial).groups[0]).toMatchObject({ members: assets, evidence: { gps: 'matched' } });
    partial.set('c', exif({ latitude: 36 }));
    const result = detectStackCandidates(assets, partial);
    expect(result.groups[0].members).toEqual(members); expect(result.unmatched.map(a => a.id)).toEqual(['c']);
    expect(result.groups[0].evidence.gps).toBe('unavailable');
  });
  it('checks whole-group TIME and GPS spread rather than chaining compatible pairs', () => {
    const assets = [...members, asset('c', 'third.jpg', false)];
    for (const overrides of [
      { b: exif({ date_time_original: '2026:10:01 08:25:51' }), c: exif({ date_time_original: '2026:10:01 08:25:53' }) },
      { b: exif({ latitude: 35.000009 }), c: exif({ latitude: 35.000018 }) },
      { b: exif({ longitude: 139.000009 }), c: exif({ longitude: 139.000018 }) },
    ]) {
      const result = detectStackCandidates(assets, details(assets, overrides));
      expect(result.groups.map(g => g.members.map(a => a.id))).toEqual([['a', 'b']]); expect(result.unmatched).toEqual([assets[2]]);
    }
  });
  it('checks CAM for every member and forms disjoint groups in selection order', () => {
    const assets = [members[0], asset('c', 'c.jpg', false), members[1], asset('d', 'd.jpg', false)];
    const result = detectStackCandidates(assets, details(assets, { c: exif({ model: 'Other' }), d: exif({ model: 'Other' }) }));
    expect(result.groups.map(g => g.members.map(a => a.id))).toEqual([['a', 'b'], ['c', 'd']]); expect(result.unmatched).toEqual([]);
  });
  it('preserves NAME priority and selection order even with identical EXIF', () => {
    const assets = [members[0], ...pair, members[1]];
    const result = detectStackCandidates(assets, details(assets));
    expect(result.groups.map(g => g.members)).toEqual([members, pair]);
    expect(result.groups.map(g => g.evidence.nameReason)).toEqual(['exif-fallback', 'filename-family']);
  });
});

describe('detail targets', () => {
  it.each([false, true])('requests two unmatched assets regardless of raw=%s', raw => {
    const members = [asset('a', 'a.jpg', raw), asset('b', 'b.jpg', raw)];
    expect(stackCandidateDetailTargets([...members, members[0], { ...pair[0], stackId: 'existing' }])).toEqual(members);
    expect(stackCandidateDetailTargets([members[0]])).toEqual([]);
  });
  it('requests NAME evidence with a singleton remaining fallback pool', () => {
    expect(stackCandidateDetailTargets([...pair, asset('single', 'single.jpg', false)])).toEqual(pair);
  });
});

describe('EXIF evidence', () => {
  it.each([['2026:10:01 08:25:49', '2026-10-01T08:25:51', 'matched'], ['2026-10-01T08:25:49Z', '2026-10-01T08:25:51.001Z', 'mismatch'], ['2026-10-01T17:25:49+09:00', '2026-10-01T08:25:49Z', 'matched'], ['invalid', '2026-10-01T08:25:49Z', 'error'], ['2026-02-30T08:25:49Z', '2026-10-01T08:25:49Z', 'error']])('TIME %s / %s = %s', (a, b, state) => expect(evidence({ date_time_original: a }, { date_time_original: b }).time).toBe(state));
  it('does not substitute RecentAsset.date for missing EXIF time', () => expect(evidence({}, {}).time).toBe('unavailable'));
  it('matches complete trimmed case-insensitive camera pairs only', () => {
    expect(evidence({ make: ' Canon ', model: 'R5' }, { make: 'canon', model: ' r5 ' }).camera).toBe('matched');
    expect(evidence({ make: 'Canon', model: 'R5' }, { make: 'Canon', model: 'R6' }).camera).toBe('mismatch');
    expect(evidence({ make: 'Canon' }, { make: 'Canon', model: 'R5' }).camera).toBe('unavailable');
    expect(evidence({ make: '', model: 'R5' }, { make: 'Canon', model: 'R5' }).camera).toBe('unavailable');
  });
  it('compares GPS spreads and distinguishes missing from malformed coordinates', () => {
    expect(evidence({ latitude: 35, longitude: 139 }, { latitude: 35.000005, longitude: 139.000005 }).gps).toBe('matched');
    expect(evidence({ latitude: 35, longitude: 139 }, { latitude: 36, longitude: 139 }).gps).toBe('mismatch');
    expect(evidence({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }).gps).toBe('matched');
    for (const exif of [{}, { latitude: 35 }, { latitude: NaN, longitude: 1 }, { latitude: 91, longitude: 1 }, { latitude: 0, longitude: Infinity }, { latitude: 0, longitude: 181 }]) expect(evidence(exif, { latitude: 35, longitude: 139 }).gps).toBe(exif.latitude == null || exif.longitude == null ? 'unavailable' : 'error');
  });
  it('keeps NAME candidates for missing details and all mismatching evidence', () => {
    expect(detectStackCandidates(pair).groups[0].evidence).toMatchObject({ time: 'unavailable', camera: 'unavailable', gps: 'unavailable' });
    expect(detectStackCandidates(pair, new Map([['raw', { make: 'A', model: 'A' }], ['jpg', { make: 'B', model: 'B' }]])).groups).toHaveLength(1);
  });
  it('rejects rolled dates, invalid times and invalid offsets deterministically', () => {
    for (const time of ['2026-13-01T00:00:00', '2026-10-01T24:00:00', '2026-10-01T00:61:00', '2026-10-01T00:00:00+24:00', '2026-10-01', null]) expect(parseStackDate(time)).toBeNull();
    expect(parseStackDate('2024-02-29T00:00:00')).not.toBeNull();
  });
});
describe('COVER ordering', () => {
  it('prefers JPEG over a newer RAW or other Non-RAW', () => expect(chooseStackCover([pair[1], asset('new', 'IMG_1234.png', false, '2026-10-02'), asset('raw', 'IMG_1234.dng', true, '2026-10-03')])).toBe('jpg'));
  it('picks the latest JPEG and preserves input order on equal or invalid dates', () => {
    const later = asset('later', 'IMG_1234.jpeg', false, '2026-10-02'); expect(chooseStackCover([pair[1], later])).toBe('later');
    expect(chooseStackCover([pair[1], { ...later, date: pair[1].date }])).toBe('jpg');
    expect(chooseStackCover([{ ...pair[1], date: 'invalid' }, { ...later, date: 'invalid' }])).toBe('jpg');
    expect(chooseStackCover([{ ...pair[1], date: 'invalid' }, later])).toBe('later');
  });
  it('falls back to latest Non-RAW, then latest member', () => {
    const older = asset('older', 'a.png', false, '2026-10-01'), later = asset('later', 'a.png', false, '2026-10-02');
    expect(chooseStackCover([older, later, pair[0]])).toBe('later'); expect(chooseStackCover([{ ...older, is_raw: true }, { ...later, is_raw: true }])).toBe('later');
  });
});

it('distinguishes failed detail from missing information for every evidence item', () => {
 const group = detectStackCandidates(pair, new Map(), new Set(['raw'])).groups[0];
 expect(group.evidence).toMatchObject({ name:'matched', time:'error', camera:'error', gps:'error' });
 expect(evidence({make: 42} as unknown as AssetExif, {}).camera).toBe('error');
});
