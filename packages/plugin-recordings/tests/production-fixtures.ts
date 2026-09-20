import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import {
  LiveRecordingCapture,
  LiveRecordingService,
  LocalRecordingBackend,
  MemoryRecordingRepository,
  type ObjectBackend,
  type PlaybackEvidenceSource,
  type RecordingMediaTransport,
} from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeMedia implements RecordingMediaTransport {
  readonly sessionId = 'session-1';
  readonly codec = 'audio/x-mulaw' as const;
  readonly sampleRate = 8000 as const;
  readonly bufferedBytes = 0;
  sent: Uint8Array[] = [];
  private audio = new Set<(audio: Uint8Array, timestampMs: number) => void>();
  private marks = new Set<(name: string) => void>();
  private closes = new Set<(reason: string) => void>();
  async sendAudio(audio: Uint8Array) {
    this.sent.push(Uint8Array.from(audio));
  }
  async sendMark(_name: string) {}
  async clear() {}
  async close(reason: string) {
    for (const listener of this.closes) listener(reason);
  }
  onAudio(listener: (audio: Uint8Array, timestampMs: number) => void) {
    this.audio.add(listener);
    return () => this.audio.delete(listener);
  }
  onMark(listener: (name: string) => void) {
    this.marks.add(listener);
    return () => this.marks.delete(listener);
  }
  onDtmf(_listener: (digit: string) => void) {
    return () => undefined;
  }
  onClose(listener: (reason: string) => void) {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
  receive(audio: Uint8Array, at: number) {
    for (const listener of this.audio) listener(audio, at);
  }
  confirm(name: string) {
    for (const listener of this.marks) listener(name);
  }
}

class Evidence implements PlaybackEvidenceSource {
  private listeners = new Set<Parameters<PlaybackEvidenceSource['subscribe']>[0]>();
  subscribe(listener: Parameters<PlaybackEvidenceSource['subscribe']>[0]) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: Parameters<Parameters<PlaybackEvidenceSource['subscribe']>[0]>[0]) {
    for (const listener of this.listeners) listener(event);
  }
}

class FaultBackend implements ObjectBackend {
  puts = 0;
  deletes = 0;
  failPutAt?: number;
  failDelete = false;
  constructor(readonly inner: ObjectBackend) {}
  async put(key: string, data: Uint8Array, contentType: string) {
    this.puts += 1;
    if (this.puts === this.failPutAt) throw new Error('simulated upload failure');
    return this.inner.put(key, data, contentType);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  async delete(key: string) {
    this.deletes += 1;
    if (this.failDelete) throw new Error('simulated delete failure');
    return this.inner.delete(key);
  }
  list(prefix: string) {
    return this.inner.list(prefix);
  }
  close() {
    this.inner.close();
  }
}

export async function harness(clock: { value: number } = { value: 1_700_000_000_000 }) {
  const directory = await mkdtemp(join(tmpdir(), 'ovo-production-recordings-'));
  directories.push(directory);
  const objects = new FaultBackend(new LocalRecordingBackend(directory));
  const repository = new MemoryRecordingRepository();
  const service = new LiveRecordingService(repository, objects, () => clock.value);
  return { directory, objects, repository, service, clock };
}

export async function captureFixture(input?: {
  failPutAt?: number;
  clock?: { value: number };
  lateEvidence?: boolean;
}) {
  const setup = await harness(input?.clock);
  setup.objects.failPutAt = input?.failPutAt;
  const media = new FakeMedia();
  const evidence = new Evidence();
  let monotonic = 1_000;
  const capture = await LiveRecordingCapture.start({
    service: setup.service,
    media,
    workspaceId: 'workspace',
    callId: 'call',
    retentionDays: 1,
    segmentBytes: 64 * 1024,
    maxQueuedBytes: 256 * 1024,
    monotonicNow: () => monotonic,
    evidence: input?.lateEvidence ? undefined : evidence,
  });
  if (input?.lateEvidence) capture.attachEvidence(evidence);
  return { ...setup, media, evidence, capture, advance: (ms: number) => (monotonic += ms) };
}
