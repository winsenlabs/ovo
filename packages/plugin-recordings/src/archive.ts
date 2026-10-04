import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ObjectBackend } from './backend.ts';
import { inspectWav } from './wav.ts';
const Segment = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const RecordingSchema = z
  .object({
    id: z.uuid(),
    workspaceId: Segment,
    callId: Segment,
    source: z.enum(['fixture', 'carrier']),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
    sampleRate: z.number(),
    channels: z.number(),
    bitsPerSample: z.number(),
    format: z.enum(['pcm', 'mulaw']),
    durationMs: z.number().positive(),
  })
  .strict();
export type Recording = z.infer<typeof RecordingSchema>;
export interface PutRecording {
  workspaceId: string;
  callId: string;
  wav: Uint8Array;
  retentionDays: number;
  source: 'fixture' | 'carrier';
}
export class RecordingArchive {
  constructor(
    private readonly backend: ObjectBackend,
    private readonly clock: () => number = Date.now,
  ) {}
  private prefix(workspaceId: string, callId: string) {
    return `${Segment.parse(workspaceId)}/${Segment.parse(callId)}/`;
  }
  private key(workspaceId: string, callId: string, id: string, suffix: 'wav' | 'json') {
    return this.prefix(workspaceId, callId) + z.uuid().parse(id) + '.' + suffix;
  }
  async put(input: PutRecording): Promise<Recording> {
    z.number().int().min(1).max(365).parse(input.retentionDays);
    z.enum(['fixture', 'carrier']).parse(input.source);
    const info = inspectWav(input.wav),
      id = randomUUID(),
      at = this.clock();
    const recording: Recording = {
      id,
      workspaceId: input.workspaceId,
      callId: input.callId,
      source: input.source,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + input.retentionDays * 86400000).toISOString(),
      sha256: createHash('sha256').update(input.wav).digest('hex'),
      bytes: input.wav.length,
      ...info,
    };
    const prefix = this.prefix(input.workspaceId, input.callId);
    if ((await this.backend.list(prefix)).length >= 100)
      throw new Error('Call recording limit reached');
    await this.backend.put(prefix + id + '.wav', input.wav, 'audio/wav');
    try {
      await this.backend.put(
        prefix + id + '.json',
        Buffer.from(JSON.stringify(recording)),
        'application/json',
      );
    } catch (error) {
      await this.backend.delete(prefix + id + '.wav').catch(() => {});
      throw error;
    }
    return recording;
  }
  private async metadata(workspaceId: string, callId: string, id: string): Promise<Recording> {
    const bytes = await this.backend.get(this.key(workspaceId, callId, id, 'json'));
    if (bytes.length > 8192) throw new Error('Invalid recording metadata');
    const value = RecordingSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    if (value.workspaceId !== workspaceId || value.callId !== callId || value.id !== id)
      throw new Error('Recording scope mismatch');
    if (Date.parse(value.expiresAt) <= this.clock()) throw new Error('Recording expired');
    return value;
  }
  async list(workspaceId: string, callId: string): Promise<Recording[]> {
    const prefix = this.prefix(workspaceId, callId),
      keys = await this.backend.list(prefix),
      result: Recording[] = [];
    for (const key of keys) {
      const id = key.slice(prefix.length, -5);
      try {
        result.push(await this.metadata(workspaceId, callId, id));
      } catch (error) {
        if (error instanceof Error && error.message === 'Recording expired') continue;
        throw error;
      }
    }
    return result;
  }
  async read(
    workspaceId: string,
    callId: string,
    id: string,
  ): Promise<{ metadata: Recording; wav: Uint8Array }> {
    const metadata = await this.metadata(workspaceId, callId, id),
      wav = await this.backend.get(this.key(workspaceId, callId, id, 'wav'));
    if (
      wav.length !== metadata.bytes ||
      createHash('sha256').update(wav).digest('hex') !== metadata.sha256
    )
      throw new Error('Recording integrity check failed');
    return { metadata, wav };
  }
  async delete(workspaceId: string, callId: string, id: string) {
    await this.backend.delete(this.key(workspaceId, callId, id, 'wav'));
    await this.backend.delete(this.key(workspaceId, callId, id, 'json'));
  }
}
