import { describe, expect, it } from 'vitest';
import { readJpegProfile } from './jpegProfile';

function profile(description: string, mluc = false) {
  const text = mluc ? new Uint8Array([...description].flatMap(char => [0, char.charCodeAt(0)])) : new TextEncoder().encode(description + '\0');
  const tagSize = (mluc ? 28 : 12) + text.length;
  const bytes = new Uint8Array(144 + tagSize);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  view.setUint32(0, bytes.length); write(36, 'acsp'); view.setUint32(128, 1);
  write(132, 'desc'); view.setUint32(136, 144); view.setUint32(140, tagSize);
  write(144, mluc ? 'mluc' : 'desc');
  if (mluc) {
    view.setUint32(152, 1); view.setUint32(156, 12); write(160, 'enUS');
    view.setUint32(164, text.length); view.setUint32(168, 28); bytes.set(text, 172);
  } else { view.setUint32(152, text.length); bytes.set(text, 156); }
  return bytes;
}
function segment(bytes: Uint8Array, sequence = 1, total = 1) {
  const prefix = new TextEncoder().encode('ICC_PROFILE\0');
  const length = bytes.length + 16;
  return new Uint8Array([0xff, 0xe2, length >> 8, length & 255, ...prefix, sequence, total, ...bytes]);
}
const jpeg = (...segments: Uint8Array[]) => new Blob([new Uint8Array([0xff, 0xd8]), ...segments.map(bytes => new Uint8Array(bytes)), new Uint8Array([0xff, 0xda])]);
const read = (blob: Blob) => readJpegProfile(blob, new AbortController().signal);

describe('JPEG embedded ICC metadata', () => {
  it('reads v2 sRGB and v4 Display P3 descriptions', async () => {
    expect(await read(jpeg(segment(profile('sRGB IEC61966-2.1'))))).toEqual({ status: 'embedded', description: 'sRGB IEC61966-2.1' });
    expect(await read(jpeg(segment(profile('Display P3', true))))).toEqual({ status: 'embedded', description: 'Display P3' });
  });
  it('assembles out-of-order ICC segments and distinguishes absent from malformed', async () => {
    const bytes = profile('Display P3', true);
    expect(await read(jpeg(segment(bytes.subarray(80), 2, 2), segment(bytes.subarray(0, 80), 1, 2)))).toEqual({ status: 'embedded', description: 'Display P3' });
    expect(await read(jpeg())).toEqual({ status: 'none' });
    expect(await read(jpeg(segment(bytes.subarray(0, 80), 1, 2)))).toEqual({ status: 'unknown' });
    expect(await read(jpeg(segment(bytes, 1, 2), segment(bytes, 1, 2)))).toEqual({ status: 'unknown' });
    bytes[36] = 0;
    expect(await read(jpeg(segment(bytes)))).toEqual({ status: 'unknown' });
  });
  it('rejects non-JPEG, invalid offsets and aborted metadata reads', async () => {
    await expect(read(new Blob(['not JPEG']))).rejects.toThrow('Not a JPEG');
    const bytes = profile('sRGB'); new DataView(bytes.buffer).setUint32(136, 0xfffffff0);
    expect(await read(jpeg(segment(bytes)))).toEqual({ status: 'unknown' });
    const controller = new AbortController(); controller.abort();
    await expect(readJpegProfile(jpeg(), controller.signal)).rejects.toThrow();
  });
  it('does not read the compressed image payload', async () => {
    const blob = new Blob([jpeg(), new Uint8Array(1024 * 1024)]);
    const originalSlice = blob.slice.bind(blob);
    let readBytes = 0;
    blob.slice = (start = 0, end = blob.size) => { readBytes += end - start; return originalSlice(start, end); };
    expect(await read(blob)).toEqual({ status: 'none' });
    expect(readBytes).toBe(4);
  });
});
