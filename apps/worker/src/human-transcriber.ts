import type {
  AudioFormat,
  EngineEvent,
  SpeechToText,
  SttEvent,
  SttSession,
  UsageSink,
} from '@winsendotai/ovo-contracts';

/** An opened STT selection and how to close it (`openReleaseStt` of the router release). */
export interface OpenedStt {
  stt: SpeechToText;
  close(): Promise<void>;
}
export type OpenStt = (usage: UsageSink) => Promise<OpenedStt | undefined>;

/** A transcript event as the call's telemetry takes it (its text policy applies there). */
export type TranscriptEvent = Extract<
  EngineEvent,
  { type: 'user.transcript' | 'agent.transcript' }
>;
export type TranscriptSink = (event: TranscriptEvent, segment: number) => void;

/** A caption on its way to the operator: `ovo.caption` data messages (human queue design 4.3). */
export interface Caption {
  role: 'caller' | 'operator';
  text: string;
  final: boolean;
  at: number;
}

export interface TranscriberInput {
  open: OpenStt;
  usage: UsageSink;
  format: AudioFormat;
  /** The STT language of the router release. */
  language: string;
  sessionId: string;
  /** Prefixes segment and turn ids (`s2:`), so ids never collide with an earlier segment's. */
  idPrefix: string;
  /** Also listen to the operator's track. */
  operator: boolean;
  caption(caption: Caption): void;
  transcript(event: TranscriptEvent): void;
  now(): number;
  /** Captions are off for the rest of the call; the call itself is unaffected. */
  failed(reason: string): void;
}

interface Track {
  role: Caption['role'];
  session?: SttSession;
  opening: Promise<void>;
  count: number;
}

/**
 * The silent transcriber of a managed queue (human queue design 7.5, `ai.mode: transcribe`): the
 * router release's own STT on the caller's frames and, when asked, on the operator's. Finals
 * become captions for the operator and transcript events for the call, which the call's text
 * policy filters like any other (`omit` stores no words, captions still reach the desk). Any
 * failure turns captions off and nothing else: the call never waits on it, never fails with it.
 */
export class HumanTranscriber {
  private stopped = false;
  private closing?: Promise<void>;
  private opened?: OpenedStt;
  private readonly tracks: Track[] = [];
  private readonly abort = new AbortController();
  private readonly startedAt: number;

  private constructor(private readonly input: TranscriberInput) {
    this.startedAt = input.now();
  }

  /** Opens the STT; undefined (no captions) when the release has none or it cannot open. */
  static async open(input: TranscriberInput): Promise<HumanTranscriber | undefined> {
    const transcriber = new HumanTranscriber(input);
    try {
      const opened = await input.open(input.usage);
      if (!opened) return undefined;
      transcriber.opened = opened;
    } catch {
      // swallow-ok: captions are an extra; the call goes on without them.
      input.failed('open_failed');
      return undefined;
    }
    transcriber.tracks.push(transcriber.track('caller'));
    if (input.operator) transcriber.tracks.push(transcriber.track('operator'));
    return transcriber;
  }

  callerAudio(frame: Uint8Array): void {
    this.write(this.tracks[0], frame);
  }

  operatorAudio(frame: Uint8Array): void {
    this.write(
      this.tracks.find((track) => track.role === 'operator'),
      frame,
    );
  }

  close(): Promise<void> {
    return (this.closing ??= this.shutdown());
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await Promise.allSettled(this.tracks.map((track) => track.opening));
    await Promise.allSettled(
      this.tracks.map((track) => track.session?.finish(AbortSignal.timeout(1_000))),
    );
    await this.opened?.close().catch(() => undefined);
  }

  private track(role: Caption['role']): Track {
    const track: Track = { role, opening: Promise.resolve(), count: 0 };
    track.opening = this.opened!.stt.start({
      sessionId: `${this.input.sessionId}:${role}`,
      format: this.input.format,
      language: this.input.language,
      signal: this.abort.signal,
      onEvent: (event) => this.onEvent(track, event),
      onUsage: this.input.usage,
    }).then(
      (session) => void (track.session = session),
      () => this.fail('start_failed'),
    );
    return track;
  }

  private write(track: Track | undefined, frame: Uint8Array): void {
    if (this.stopped || !track?.session) return;
    track.session.write(frame).catch(() => this.fail('write_failed'));
  }

  private onEvent(track: Track, event: SttEvent): void {
    if (this.stopped || event.type !== 'transcript') return;
    try {
      const { segment } = event;
      const text = segment.text.trim();
      if (!text) return;
      const final = segment.stability === 'final';
      const at = this.input.now() - this.startedAt;
      this.input.caption({ role: track.role, text: text.slice(0, 500), final, at });
      if (!final) return;
      track.count += 1;
      const id = `${this.input.idPrefix}h${track.role[0]}${track.count}`;
      this.input.transcript(
        track.role === 'caller'
          ? { type: 'user.transcript', turnId: id, segmentId: id, text, stability: 'final' }
          : { type: 'agent.transcript', segmentId: id, text, state: 'played' },
      );
    } catch {
      // swallow-ok: a sink that throws turns captions off, never the call.
      this.fail('sink_failed');
    }
  }

  private fail(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.input.failed(reason);
    void this.close().catch(() => undefined);
  }
}
