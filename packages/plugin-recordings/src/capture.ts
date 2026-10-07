import type { LiveRecordingService } from './live-service.ts';
import type { LiveRecording, RecordingTimelineEvent, RecordingTrack } from './types.ts';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import {
  captureError,
  recordingBytesPerSecond,
  supportedRecordingFormat,
  takeSegment,
  type CaptureOutcome,
  type PendingTrack,
  type PlaybackEvidenceSource,
  type RecordingMediaTransport,
} from './capture-types.ts';

export type {
  CaptureOutcome,
  PlaybackEvidenceSource,
  RecordingMediaTransport,
} from './capture-types.ts';

export class LiveRecordingCapture implements RecordingMediaTransport {
  readonly identity: unknown;
  readonly sessionId: string;
  readonly format: NonNullable<RecordingMediaTransport['format']>;
  readonly codec: RecordingMediaTransport['codec'];
  readonly sampleRate: RecordingMediaTransport['sampleRate'];
  private readonly startedMonotonic: number;
  private readonly tracks: Record<RecordingTrack, PendingTrack> = {
    inbound: { bytes: [], byteLength: 0, sequence: 0 },
    outbound: { bytes: [], byteLength: 0, sequence: 0 },
  };
  /** Bytes per track durably written as available segments. */
  private readonly written: Record<RecordingTrack, number> = { inbound: 0, outbound: 0 };
  private readonly unsubscribers: Array<() => void> = [];
  private chain = Promise.resolve();
  private timelineSequence = 0;
  private queuedBytes = 0;
  private stopped = false;
  private partial = false;

  private constructor(
    private readonly service: LiveRecordingService,
    private readonly recording: LiveRecording,
    private readonly media: RecordingMediaTransport,
    private readonly maxQueuedBytes: number,
    monotonicNow: () => number,
    evidence?: PlaybackEvidenceSource,
  ) {
    this.identity = media.identity;
    this.sessionId = media.sessionId;
    this.format = media.format ?? MULAW_8K;
    this.codec = media.codec;
    this.sampleRate = media.sampleRate;
    this.monotonicNow = monotonicNow;
    this.startedMonotonic = monotonicNow();
    this.unsubscribers.push(
      media.onAudio((audio, timestampMs) => this.enqueueAudio('inbound', audio, timestampMs)),
      media.onMark((name) => {
        this.enqueueTimeline(
          'playback-mark-confirmed',
          'carrier-mark-confirmed-not-human-heard',
          name,
        );
      }),
      media.onClose(() => void this.finish()),
    );
    if (evidence) this.attachEvidence(evidence);
  }

  private readonly monotonicNow: () => number;

  static async start(input: {
    service: LiveRecordingService;
    media: RecordingMediaTransport;
    workspaceId: string;
    callId: string;
    retentionDays: number;
    segmentBytes?: number;
    maxQueuedBytes?: number;
    monotonicNow?: () => number;
    evidence?: PlaybackEvidenceSource;
  }): Promise<LiveRecordingCapture> {
    const format = input.media.format ?? MULAW_8K;
    if (!supportedRecordingFormat(format))
      throw new Error('Live recording requires μ-law 8 kHz or PCM16 8/16 kHz media');
    if (
      input.media.codec !== (format.encoding === 'mulaw' ? 'audio/x-mulaw' : 'audio/pcm') ||
      input.media.sampleRate !== format.sampleRate
    )
      throw new Error('Live recording media format and codec disagree');
    const recording = await input.service.create({ ...input, format });
    await input.service.state(recording.id, 'active');
    return new LiveRecordingCapture(
      input.service,
      recording,
      input.media,
      input.maxQueuedBytes ?? recording.segmentBytes * 2,
      input.monotonicNow ?? (() => performance.now()),
      input.evidence,
    );
  }

  get artifact(): LiveRecording {
    return { ...this.recording };
  }

  /**
   * What the artifact holds: `available`, or `partial` when audio was lost on the way (a failed
   * upload, a full queue). Final once `finish` has settled.
   */
  get outcome(): CaptureOutcome {
    return { state: this.partial ? 'partial' : 'available', bytes: { ...this.written } };
  }

  attachEvidence(evidence: PlaybackEvidenceSource): () => void {
    if (this.stopped) return () => undefined;
    let attached = true;
    const unsubscribe = evidence.subscribe((item) => {
      this.enqueueTimeline(
        'speech-evidence',
        item.evidence === 'confirmed'
          ? 'scheduler-confirmed'
          : item.evidence === 'estimated'
            ? 'scheduler-estimated'
            : 'scheduler-generated',
        item.segmentId,
        item.phase,
        Math.max(0, item.at - this.service.now() + this.elapsed()),
      );
    });
    const detach = () => {
      if (!attached) return;
      attached = false;
      unsubscribe();
    };
    this.unsubscribers.push(detach);
    return detach;
  }

  get bufferedBytes(): number {
    return this.media.bufferedBytes;
  }

  async sendAudio(audio: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.media.sendAudio(audio, signal);
    this.enqueueAudio('outbound', audio, this.elapsed());
  }

  async sendMark(name: string, signal?: AbortSignal): Promise<void> {
    await this.media.sendMark(name, signal);
    this.enqueueTimeline('playback-sent', 'worker-send-resolved', name);
  }

  clear(signal?: AbortSignal) {
    return this.media.clear(signal);
  }

  async close(reason: string): Promise<void> {
    await this.finish();
    await this.media.close(reason);
  }

  onAudio(listener: (audio: Uint8Array, timestampMs: number) => void) {
    return this.media.onAudio(listener);
  }

  onMark(listener: (name: string) => void) {
    return this.media.onMark(listener);
  }

  onDtmf(listener: (digit: string) => void) {
    return this.media.onDtmf(listener);
  }

  onClose(listener: (reason: string) => void) {
    return this.media.onClose(listener);
  }

  async finish(): Promise<void> {
    if (this.stopped) return this.chain;
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.chain = this.chain
      .then(async () => {
        await this.flush('inbound');
        await this.flush('outbound');
        await this.service.state(this.recording.id, 'finalizing');
        await this.service.state(this.recording.id, this.partial ? 'partial' : 'available');
      })
      .catch(async (error) => {
        this.partial = true;
        await this.service
          .state(this.recording.id, 'partial', captureError(error))
          .catch(() => undefined);
      });
    return this.chain;
  }

  private enqueueAudio(track: RecordingTrack, input: Uint8Array, timestampMs: number): void {
    if (this.stopped || !input.byteLength) return;
    const audio = Uint8Array.from(input);
    if (this.queuedBytes + audio.byteLength > this.maxQueuedBytes) {
      this.partial = true;
      this.stopped = true;
      for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
      this.chain = this.chain.then(() =>
        this.service.state(this.recording.id, 'partial', 'Recording capture queue overflow'),
      );
      return;
    }
    this.queuedBytes += audio.byteLength;
    this.chain = this.chain
      .then(() => this.append(track, audio, timestampMs))
      .catch((error) => this.fail(error))
      .finally(() => {
        this.queuedBytes -= audio.byteLength;
      });
  }

  private async append(trackName: RecordingTrack, audio: Uint8Array, timestampMs: number) {
    const track = this.tracks[trackName];
    let offset = 0;
    while (offset < audio.byteLength) {
      const remaining = this.recording.segmentBytes - track.byteLength;
      const chunk = audio.slice(offset, offset + remaining);
      track.bytes.push(chunk);
      track.byteLength += chunk.byteLength;
      const bytesPerMs = recordingBytesPerSecond(this.format) / 1_000;
      track.startMs ??= timestampMs + offset / bytesPerMs;
      track.endMs = timestampMs + (offset + chunk.byteLength) / bytesPerMs;
      offset += chunk.byteLength;
      if (track.byteLength === this.recording.segmentBytes) await this.flush(trackName);
    }
  }

  private async flush(trackName: RecordingTrack): Promise<void> {
    const track = this.tracks[trackName];
    if (!track.byteLength) return;
    // Taken out of the buffer first: a failed upload is not retried into the next segment.
    const { bytes, startMs, endMs } = takeSegment(track);
    await this.service.writeSegment({
      recording: this.recording,
      track: trackName,
      sequence: track.sequence,
      bytes,
      startMs,
      endMs,
    });
    track.sequence += 1;
    this.written[trackName] += bytes.byteLength;
  }

  private enqueueTimeline(
    type: RecordingTimelineEvent['type'],
    evidence: RecordingTimelineEvent['evidence'],
    reference: string,
    phase?: string,
    atMs = this.elapsed(),
  ): void {
    if (this.stopped) return;
    const event: RecordingTimelineEvent = {
      artifactId: this.recording.id,
      sequence: ++this.timelineSequence,
      atMs,
      type,
      evidence,
      reference: reference.slice(0, 200),
      phase,
    };
    this.chain = this.chain
      .then(() => this.service.timeline(event))
      .catch((error) => this.fail(error));
  }

  private async fail(error: unknown): Promise<void> {
    this.partial = true;
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await this.service
      .state(this.recording.id, 'partial', captureError(error))
      .catch(() => undefined);
  }

  private elapsed(): number {
    return Math.max(0, this.monotonicNow() - this.startedMonotonic);
  }
}
