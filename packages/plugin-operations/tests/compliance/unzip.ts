import { crc32, inflateRawSync } from 'node:zlib';
import { expect } from 'vitest';

/** Reads every entry back through the central directory, as an unzip tool would. */
export function unzip(archive: Buffer): Map<string, Buffer> {
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(at)).toBe(0x02014b50);
    const size = archive.readUInt32LE(at + 20);
    const checksum = archive.readUInt32LE(at + 16);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + archive.readUInt16LE(local + 26);
    const data = inflateRawSync(archive.subarray(start, start + size));
    expect(crc32(data)).toBe(checksum);
    files.set(name, data);
    at += 46 + nameLength;
  }
  return files;
}
