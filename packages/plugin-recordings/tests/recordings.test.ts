import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { compose } from '@winsendotai/ovo-runtime';
import { RecordingArchive, inspectWav, recordingsPlugin } from '../src/index.ts';
import { LocalRecordingBackend } from '../src/backend.ts';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
function fixture() {
  const out = Buffer.alloc(44 + 1600);
  out.write('RIFF');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(8000, 24);
  out.writeUInt32LE(16000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(1600, 40);
  return out;
}
async function archive() {
  const dir = await mkdtemp(join(tmpdir(), 'ovo-recordings-'));
  directories.push(dir);
  return { dir, store: new RecordingArchive(new LocalRecordingBackend(dir)) };
}
describe('recording archive, real local files and simulated audio', () => {
  it('validates the real envelope and computes duration rather than trusting metadata', () => {
    expect(inspectWav(fixture())).toMatchObject({ durationMs: 100, sampleRate: 8000, channels: 1 });
    const truncated = fixture().subarray(0, 100);
    expect(() => inspectWav(truncated)).toThrow();
    const invalid = fixture();
    invalid.writeUInt32LE(1, 28);
    expect(() => inspectWav(invalid)).toThrow('Inconsistent');
  });
  it('persists across reopen and keeps fixture provenance and workspace isolation', async () => {
    const { dir, store } = await archive();
    const record = await store.put({
      workspaceId: 'w',
      callId: 'c',
      wav: fixture(),
      retentionDays: 1,
      source: 'fixture',
    });
    const reopened = new RecordingArchive(new LocalRecordingBackend(dir));
    const content = await reopened.read('w', 'c', record.id);
    expect(content.metadata.source).toBe('fixture');
    expect(Buffer.from(content.wav)).toEqual(fixture());
    expect(await reopened.list('other', 'c')).toEqual([]);
    await expect(reopened.read('other', 'c', record.id)).rejects.toThrow();
    await expect(reopened.list('../w', 'c')).rejects.toThrow();
  });
  it('detects corruption and expires access without claiming physical deletion', async () => {
    const { dir, store } = await archive();
    const record = await store.put({
      workspaceId: 'w',
      callId: 'c',
      wav: fixture(),
      retentionDays: 1,
      source: 'fixture',
    });
    await writeFile(join(dir, 'w', 'c', record.id + '.wav'), Buffer.alloc(44));
    await expect(store.read('w', 'c', record.id)).rejects.toThrow('integrity');
    const later = new RecordingArchive(new LocalRecordingBackend(dir), () => Date.now() + 86400001);
    expect(await later.list('w', 'c')).toEqual([]);
    await expect(later.read('w', 'c', record.id)).rejects.toThrow('expired');
    await later.delete('w', 'c', record.id);
    await later.delete('w', 'c', record.id);
    expect(await store.list('w', 'c')).toEqual([]);
  });
  it('loads as an ordinary disposable storage plugin', async () => {
    const { dir } = await archive();
    const composition = await compose(
      [{ id: 'ovo.recordings', config: { backend: 'local', directory: dir } }],
      [recordingsPlugin],
    );
    expect(composition.ctx.get('ovo.recordings')).toBeInstanceOf(RecordingArchive);
    await composition.dispose();
  });
});
