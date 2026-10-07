import { describe, expect, it } from 'vitest';
import { zipFiles } from '../../src/compliance/zip.ts';
import { unzip } from './unzip.ts';

describe('the export ZIP writer', () => {
  it('round-trips files through the central directory with matching checksums', () => {
    const files = [
      { name: 'decisions.csv', data: Buffer.from('id,verdict\r\n1,allow\r\n') },
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ files: 1 })) },
      { name: 'empty.csv', data: Buffer.alloc(0) },
    ];
    const read = unzip(zipFiles(files));
    expect([...read.keys()]).toEqual(['decisions.csv', 'manifest.json', 'empty.csv']);
    for (const file of files) expect(read.get(file.name)).toEqual(file.data);
  });
});
