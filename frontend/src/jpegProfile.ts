export type JpegProfile = { status: 'embedded'; description: string } | { status: 'none' | 'unknown' };
const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

function describeProfile(bytes: Uint8Array): JpegProfile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 132 || ascii(bytes.subarray(36, 40)) !== 'acsp') return { status: 'unknown' };
  const size = view.getUint32(0);
  if (size < 132 || size > bytes.length) return { status: 'unknown' };
  const count = view.getUint32(128);
  if (count > (size - 132) / 12) return { status: 'unknown' };
  for (let i = 0; i < count; i++) {
    const entry = 132 + i * 12;
    if (ascii(bytes.subarray(entry, entry + 4)) !== 'desc') continue;
    const offset = view.getUint32(entry + 4);
    const length = view.getUint32(entry + 8);
    if (offset < 132 || length < 12 || offset + length > size) return { status: 'unknown' };
    const type = ascii(bytes.subarray(offset, offset + 4));
    let description = '';
    if (type === 'desc') {
      const textLength = view.getUint32(offset + 8);
      if (textLength < 1 || textLength > length - 12) return { status: 'unknown' };
      description = new TextDecoder('ascii').decode(bytes.subarray(offset + 12, offset + 12 + textLength));
    } else if (type === 'mluc' && length >= 16) {
      const records = view.getUint32(offset + 8);
      const recordSize = view.getUint32(offset + 12);
      if (recordSize < 12 || records < 1 || records > (length - 16) / recordSize) return { status: 'unknown' };
      let record = offset + 16;
      for (let j = 0; j < records; j++) {
        const candidate = offset + 16 + j * recordSize;
        if (ascii(bytes.subarray(candidate, candidate + 2)) === 'en') { record = candidate; break; }
      }
      const textLength = view.getUint32(record + 4);
      const textOffset = view.getUint32(record + 8);
      if (textLength % 2 || textOffset < 16 + records * recordSize || textOffset + textLength > length) return { status: 'unknown' };
      description = new TextDecoder('utf-16be').decode(bytes.subarray(offset + textOffset, offset + textOffset + textLength));
    }
    // Profile descriptions are metadata, not proof of a particular transform.
    description = description.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
    return description ? { status: 'embedded', description } : { status: 'unknown' };
  }
  return { status: 'unknown' };
}

export async function readJpegProfile(blob: Blob, signal: AbortSignal): Promise<JpegProfile> {
  const read = async (offset: number, size: number) => {
    signal.throwIfAborted();
    if (offset + size > blob.size) throw new Error('Truncated JPEG header');
    const bytes = new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
    signal.throwIfAborted();
    return bytes;
  };
  const start = await read(0, 2);
  if (start[0] !== 0xff || start[1] !== 0xd8) throw new Error('Not a JPEG original');
  const chunks = new Map<number, Uint8Array>();
  let total = 0;
  let offset = 2;
  try {
    // Inspect only JPEG metadata, never copy the full compressed image into JS memory.
    while (offset < Math.min(blob.size, 16 * 1024 * 1024)) {
      let header = await read(offset, 2);
      if (header[0] !== 0xff) return { status: 'unknown' };
      if (header[1] === 0xff) { offset++; continue; }
      if (header[1] === 0xda || header[1] === 0xd9) {
        if (!total) return { status: 'none' };
        if (chunks.size !== total) return { status: 'unknown' };
        const bytes = new Uint8Array([...chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0));
        let position = 0;
        for (let i = 1; i <= total; i++) {
          const chunk = chunks.get(i)!;
          bytes.set(chunk, position); position += chunk.length;
        }
        return describeProfile(bytes);
      }
      if (header[1] === 0x01 || (header[1] >= 0xd0 && header[1] <= 0xd7)) { offset += 2; continue; }
      const marker = header[1];
      header = await read(offset + 2, 2);
      const length = header[0] * 256 + header[1];
      if (length < 2 || offset + 2 + length > blob.size) return { status: 'unknown' };
      if (marker === 0xe2 && length >= 16) {
        const payload = await read(offset + 4, length - 2);
        if (ascii(payload.subarray(0, 12)) === 'ICC_PROFILE\0') {
          const sequence = payload[12];
          const count = payload[13];
          if (!count || !sequence || sequence > count || chunks.has(sequence) || (total && total !== count)) return { status: 'unknown' };
          total = count; chunks.set(sequence, payload.subarray(14));
        }
      }
      offset += length + 2;
    }
  } catch (error) {
    if (signal.aborted) throw error;
  }
  return { status: 'unknown' };
}
