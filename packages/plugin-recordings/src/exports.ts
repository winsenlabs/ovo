import { createHash, randomUUID } from 'node:crypto';
import type { ObjectBackend } from './backend.ts';
import type { RecordingRepository } from './repository.ts';
import { RecordingUnavailableError } from './repository.ts';
import { safeReplayPayload } from './replay.ts';
import type {
  ExportRedactionPolicy,
  LiveRecording,
  RecordingExportJob,
  RedactedExportInput,
} from './types.ts';

export type ExportInputLoader = (
  recording: Readonly<LiveRecording>,
  options?: { signal?: AbortSignal },
) => Promise<RedactedExportInput>;

export class RecordingExportService {
  private readonly pendingInputs = new Set<Promise<unknown>>();

  constructor(
    private readonly repository: RecordingRepository,
    private readonly objects: ObjectBackend,
    private readonly loadInput: ExportInputLoader,
    private readonly clock: () => number = Date.now,
  ) {}

  async request(input: {
    workspaceId: string;
    artifactId: string;
    idempotencyKey: string;
  }): Promise<RecordingExportJob> {
    if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(input.idempotencyKey))
      throw new Error('Invalid export idempotency key');
    const at = new Date(this.clock()).toISOString();
    return this.repository.createExport({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      idempotencyKey: input.idempotencyKey,
      state: 'queued',
      createdAt: at,
      updatedAt: at,
      attempts: 0,
      leaseEpoch: 0,
    });
  }

  async work(input: {
    owner: string;
    leaseMs?: number;
    limit?: number;
    policy?: ExportRedactionPolicy;
    signal?: AbortSignal;
  }): Promise<{ claimed: number; succeeded: number; failed: number }> {
    const limit = bounded(input.limit ?? 10, 1, 100, 'export claim limit');
    const leaseMs = bounded(input.leaseMs ?? 60_000, 1_000, 3_600_000, 'export lease');
    const now = new Date(this.clock()).toISOString();
    const jobs = await this.repository.claimExports(input.owner, now, leaseMs, limit);
    let succeeded = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        throwIfAborted(input.signal);
        await this.run(job, input.owner, input.policy ?? {}, input.signal);
        succeeded += 1;
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason ?? error;
        failed += 1;
        await this.repository
          .settleExport(job.id, input.owner, job.leaseEpoch, new Date(this.clock()).toISOString(), {
            state: 'failed',
            error: safeError(error),
          })
          .catch(() => undefined);
      }
    }
    return { claimed: jobs.length, succeeded, failed };
  }

  async read(
    workspaceId: string,
    exportId: string,
  ): Promise<{ job: RecordingExportJob; bytes: Uint8Array }> {
    const job = await this.repository.getExport(workspaceId, exportId);
    if (!job || job.state !== 'succeeded' || !job.outputKey || !job.outputSha256)
      throw new Error('Recording export is unavailable');
    const bytes = await this.objects.get(job.outputKey);
    const current = await this.repository.getExport(workspaceId, exportId);
    if (!current || current.outputKey !== job.outputKey)
      throw new Error('Recording export is unavailable');
    if (
      bytes.byteLength !== job.outputBytes ||
      createHash('sha256').update(bytes).digest('hex') !== job.outputSha256
    )
      throw new Error('Recording export integrity check failed');
    return { job, bytes };
  }

  async status(workspaceId: string, exportId: string): Promise<RecordingExportJob | undefined> {
    return this.repository.getExport(workspaceId, exportId);
  }

  async drain(): Promise<void> {
    while (this.pendingInputs.size) await Promise.allSettled([...this.pendingInputs]);
  }

  private async run(
    job: RecordingExportJob,
    owner: string,
    policy: ExportRedactionPolicy,
    signal?: AbortSignal,
  ) {
    const recording = await this.repository.findByArtifact(job.workspaceId, job.artifactId);
    if (!recording) throw new RecordingUnavailableError();
    throwIfAborted(signal);
    const loading = Promise.resolve().then(() => {
      throwIfAborted(signal);
      return this.loadInput(Object.freeze(structuredClone(recording)), { signal });
    });
    this.pendingInputs.add(loading);
    void loading.then(
      () => this.pendingInputs.delete(loading),
      () => this.pendingInputs.delete(loading),
    );
    const source = await abortable(loading, signal);
    const payload = buildRedactedExport(job.artifactId, source, policy);
    const bytes = Buffer.from(JSON.stringify(payload));
    if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('Recording export exceeds 16 MiB');
    const key = `exports/${job.workspaceId}/${job.artifactId}/${job.id}/${job.leaseEpoch}.json`;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      throwIfAborted(signal);
      await this.objects.put(key, bytes, 'application/json', { signal });
      throwIfAborted(signal);
      await this.repository.settleExport(
        job.id,
        owner,
        job.leaseEpoch,
        new Date(this.clock()).toISOString(),
        { state: 'succeeded', outputKey: key, outputSha256: sha256, outputBytes: bytes.byteLength },
      );
    } catch (error) {
      try {
        await this.objects.delete(key);
      } catch {
        await this.repository.recordCleanupObject(job.artifactId, key).catch(() => undefined);
      }
      throw error;
    }
  }
}

export function buildRedactedExport(
  artifactId: string,
  source: RedactedExportInput,
  policy: ExportRedactionPolicy,
) {
  if (source.transcript.length > 20_000 || source.events.length > 50_000)
    throw new Error('Recording export input exceeds row bound');
  if ((policy.redactPatterns?.length ?? 0) > 20)
    throw new Error('Recording export redaction policy exceeds pattern bound');
  const patterns = [/[\w.+-]+@[\w.-]+\.[\p{L}]{2,}/giu, /\+?[0-9][0-9 ()-]{7,}[0-9]/gu];
  for (const value of policy.redactPatterns ?? []) {
    if (!value.length || value.length > 200)
      throw new Error('Recording export redaction pattern exceeds length bound');
    patterns.push(new RegExp(value, 'giu'));
  }
  const replacement = policy.replacement ?? '[REDACTED]';
  const redact = (value: string) => {
    if (value.length > 20_000) throw new Error('Recording export transcript row is too large');
    return patterns.reduce((text, pattern) => text.replace(pattern, replacement), value);
  };
  return {
    schemaVersion: 1,
    replay: safeReplayPayload(artifactId),
    transcript: source.transcript
      .filter(
        (item) =>
          item.speaker !== 'agent' ||
          policy.includeUnplayedAgentText === true ||
          item.playback !== 'unplayed',
      )
      .map((item) => ({ ...item, text: redact(item.text) })),
    events: source.events.map((event) => ({
      atMs: event.atMs,
      type: event.type.slice(0, 200),
    })),
  };
}

function bounded(value: number, min: number, max: number, label: string) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}

function safeError(error: unknown) {
  if (!(error instanceof Error)) return 'Recording export failed';
  const safeMessages = [
    'Recording export input exceeds row bound',
    'Recording export redaction policy exceeds pattern bound',
    'Recording export redaction pattern exceeds length bound',
    'Recording export transcript row is too large',
    'Recording export exceeds 16 MiB',
    'Recording export source exceeds bounded event pages',
    'Recording export source returned an oversized event page',
  ];
  if (safeMessages.includes(error.message)) return error.message;
  return `Recording export failed (${safeErrorType(error)})`;
}

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  return [
    'AbortError',
    'AggregateError',
    'Error',
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TimeoutError',
    'TypeError',
    'URIError',
  ].includes(error.name)
    ? error.name
    : 'Error';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Recording export interrupted');
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Recording export interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
