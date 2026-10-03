import { describe, expect, it } from 'vitest';
import type { AssetExif, RecentAsset } from './assets';
import { chooseStackCover, detectStackCandidates, filenameFamily, parseStackDate } from './stackCandidateDetection';
const asset = (id: string, filename: string, raw: boolean, date = '2026-10-01T08:25:49Z'): RecentAsset => ({ id, filename, is_raw: raw, format: raw ? 'DNG' : filename.endsWith('.png') ? 'PNG' : 'JPEG', date, thumbnail_url: `/thumb/${id}` });
const pair = [asset('raw', 'IMG_1234.DNG', true), asset('jpg', 'IMG_1234.JPG', false)];
const evidence = (first: AssetExif, second: AssetExif) => detectStackCandidates(pair, new Map([['raw', first], ['jpg', second]])).groups[0].evidence;
describe('filename candidates', () => {
  it('matches exact stems while retaining concrete members and selection order', () => {
    const groups = detectStackCandidates(pair).groups;
    expect(groups).toHaveLength(1); expect(groups[0].members).toEqual(pair); expect(groups[0].evidence.nameReason).toBe('exact'); expect(groups[0].origin).toBe('auto'); expect(groups[0].id).toMatch(/^draft:auto:/);
  });
  it('does not merge different or case-different stems, even with identical metadata', () => {
    const assets = [pair[0], asset('other', 'img_1234.JPG', false)];
    expect(detectStackCandidates(assets, new Map(assets.map(a => [a.id, { date_time_original: a.date, make: 'Same', model: 'Same', latitude: 1, longitude: 1 }]))).groups).toHaveLength(0);
    expect(detectStackCandidates([pair[0], asset('other', 'IMG_1235.JPG', false)]).groups).toHaveLength(0);
  });
  it('normalizes only known Pixel COVER/ORIGINAL filenames and separates timestamps', () => {
    const files = ['PXL_20261001_082549596.RAW-01.COVER.jpg', 'PXL_20261001_082549596.RAW-02.ORIGINAL.dng', 'PXL_20261001_082550596.RAW-01.COVER.jpg', 'PXL_20261001_082550596.RAW-02.ORIGINAL.dng'];
    const result = detectStackCandidates(files.map((name, index) => asset(String(index), name, name.endsWith('dng'))));
    expect(result.groups).toHaveLength(2); expect(result.groups[0].evidence.nameReason).toBe('pixel-normalized');
    expect(filenameFamily(files[0])?.key).toBe('PXL_20261001_082549596');
    for (const name of ['IMG_1234.RAW-01.COVER.jpg', 'PXL_20261001_082549596.EDIT.jpg', 'PXL_20261001_082549596.RAW-01.UNKNOWN.jpg', 'PXL_20261001_082549596.RAW-01.COVER.extra.jpg', 'PXL_20261001_082549.RAW-01.COVER.jpg']) expect(filenameFamily(name)?.reason).toBe('exact');
    expect(detectStackCandidates([asset('a', 'PXL_20261001_082549596.EDIT.jpg', false), asset('b', files[1], true)]).groups).toHaveLength(0);
  });
  it('requires RAW and Non-RAW and excludes all existing Stack members', () => {
    for (const raw of [true, false]) expect(detectStackCandidates(pair.map(a => ({ ...a, is_raw: raw }))).groups).toHaveLength(0);
    const stacked = { ...pair[0], stackId: 'existing' };
    const result = detectStackCandidates([stacked, pair[1]]); expect(result.groups).toHaveLength(0); expect(result.unmatched).toEqual([stacked, pair[1]]);
    expect(detectStackCandidates([pair[0]]).groups).toHaveLength(0);
  });
  it('orders groups by first member and partitions every unique asset exactly once', () => {
    const otherRaw = asset('b-raw', 'B.dng', true), otherJpg = asset('b-jpg', 'B.jpg', false), unmatched = asset('single', 'single.jpg', false);
    const result = detectStackCandidates([otherRaw, pair[1], unmatched, pair[0], otherJpg, pair[0]]);
    expect(result.groups.map(g => g.members.map(a => a.id))).toEqual([['b-raw', 'b-jpg'], ['jpg', 'raw']]); expect(result.unmatched).toEqual([unmatched]);
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
