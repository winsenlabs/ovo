import { FrameAggregator, silence } from '@winsendotai/ovo-audio';
import { bytesPerSecond, type AudioFormat } from '@winsendotai/ovo-contracts';
import { appendEvent, commitEvent } from './protocol.ts';

/** Audio is appended in chunks of this length. */
const CHUNK_MS = 50;
/** The provider refuses a commit of less audio than this, so a short tail is padded with silence. */
const MIN_COMMIT_MS = 100;
/** Audio held until the session confirms its configuration; past this the session gives up. */
const MAX_UNCONFIGURED_MS = 15_000;

/**
 * What a session sends: audio as 50 ms `input_audio_buffer.append` events, and commits, each with
 * its own event id. Until the provider confirms the configuration (`session.updated`) everything is
 * held in order, because audio appended earlier would be read in the provider's default format.
 */
export class RealtimeOutbox {
  private readonly frames: FrameAggregator;
  private readonly perSecond: number;
  private configured = false;
  private queued: string[] = [];
  private queuedBytes = 0;
  private uncommitted = 0;
  private commitNumber = 0;
  /** Commits sent and not yet answered, oldest first. */
  private readonly open = new Set<string>();

  constructor(
    private readonly format: AudioFormat,
    private readonly send: (event: string) => void,
    /** Called once when held audio passes the limit. */
    private readonly overflow: () => void,
  ) {
    this.frames = new FrameAggregator(format, CHUNK_MS);
    this.perSecond = bytesPerSecond(format);
  }

  /** Commits still waiting for a transcript or an error. */
  get waiting(): number {
    return this.open.size;
  }

  get hasAudio(): boolean {
    return this.uncommitted > 0;
  }

  write(frame: Uint8Array): void {
    this.uncommitted += frame.byteLength;
    for (const chunk of this.frames.push(frame)) this.audio(chunk);
  }

  /** Flushes the tail (padded to the provider's minimum) and commits it. */
  commit(): void {
    const tail = this.frames.flush();
    if (tail) this.audio(tail);
    const short = (MIN_COMMIT_MS * this.perSecond) / 1000 - this.uncommitted;
    if (short > 0) this.audio(silence(this.format, Math.ceil((short * 1000) / this.perSecond)));
    const id = `ovo_commit_${++this.commitNumber}`;
    this.open.add(id);
    this.emit(commitEvent(id));
    this.uncommitted = 0;
  }

  /** The configuration is confirmed: everything held goes out, in the order it was written. */
  configure(): void {
    if (this.configured) return;
    this.configured = true;
    const held = this.queued;
    this.queued = [];
    this.queuedBytes = 0;
    for (const event of held) this.send(event);
  }

  get isConfigured(): boolean {
    return this.configured;
  }

  /** A transcript arrived: transcripts answer commits in order (a VAD commit was never ours). */
  answered(): void {
    const [oldest] = this.open;
    if (oldest !== undefined) this.open.delete(oldest);
  }

  /** True when a provider error is about one of this session's commits, which then gets nothing. */
  refused(eventId: string | undefined): boolean {
    return eventId !== undefined && this.open.delete(eventId);
  }

  discard(): void {
    this.queued = [];
    this.queuedBytes = 0;
  }

  private audio(bytes: Uint8Array): void {
    this.emit(appendEvent(bytes), bytes.byteLength);
  }

  private emit(event: string, audioBytes = 0): void {
    if (this.configured) return this.send(event);
    this.queued.push(event);
    this.queuedBytes += audioBytes;
    if ((this.queuedBytes * 1000) / this.perSecond > MAX_UNCONFIGURED_MS) this.overflow();
  }
}
