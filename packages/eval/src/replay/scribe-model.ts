// The STT of a transcript replay: Scribe (manual commit) answering the replayed detector's commits
// with the words the live call's STT wrote, at the times it wrote them. Interims land when they
// landed live. A final comes only for a commit, as with Scribe: a live final within `matchMs` of
// the replay's commit answers it as it did live (the same detector reproduces the call exactly);
// otherwise the commit is answered `commitLatencyMs` later (Scribe took 286–444 ms on the Maya
// calls) with the words heard by then, and a live final the replay did not commit stays open
// words the next commit takes. MODELLED, and the report says so: what Scribe would have finalised
// for a commit the live call never sent.
import type { Clock, SpeechToText, SttEvent, SttSession } from '@winsendotai/ovo-contracts';
import { SCRIBE_CAPABILITIES } from '@winsendotai/ovo-plugin-stt-elevenlabs';
import type { Transcript } from '../timeline.ts';

export interface ScribeModelOptions {
  /** The clock's reading at call time 0 (the transcripts are in call time). */
  zero?: number;
  commitLatencyMs?: number;
  matchMs?: number;
  /** Notes each commit and how it was answered, for the report. */
  onCommit?: (commit: { atMs: number; answeredAtMs: number; live: boolean; text: string }) => void;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const LATE_MS = 120;

class ScribeReplay {
  private segment = 0;
  private revision = 0;
  /** Words of closed live segments the replay has not committed. */
  private carried: string[] = [];
  private liveSegment?: string;
  private readonly seen = new Set<string>();
  private liveText = '';
  /** How many of the open live segment's words the replay already committed. */
  private committedWords = 0;
  private emitted = '';
  private pending?: { atMs: number; cancel: () => void };
  /** The open live segment's final, when the live call committed before this replay did. */
  private liveFinalAt?: number;
  private readonly cancels: (() => void)[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly live: readonly Transcript[],
    private readonly onEvent: (event: SttEvent) => void,
    private readonly options: ScribeModelOptions,
  ) {
    for (const transcript of live) {
      const wait = transcript.atMs - this.now();
      if (wait < 0) continue;
      this.cancels.push(clock.setTimeout(() => this.onLive(transcript), wait));
    }
  }

  /** Call time. */
  private now(): number {
    return this.clock.now() - (this.options.zero ?? 0);
  }

  private text(): string {
    const open = words(this.liveText).slice(this.committedWords);
    return [...this.carried, ...open].join(' ').trim();
  }

  private transcript(text: string, stability: 'interim' | 'final'): void {
    this.onEvent({
      type: 'transcript',
      segment: { segmentId: String(this.segment), revision: ++this.revision, text, stability },
    });
  }

  private onLive(transcript: Transcript): void {
    this.seen.add(transcript.segmentId);
    if (transcript.segmentId !== this.liveSegment) {
      // A new live segment: whatever the replay left of the last one carries on.
      const left = words(this.liveText).slice(this.committedWords);
      this.carried.push(...left);
      this.liveSegment = transcript.segmentId;
      this.committedWords = 0;
      this.liveFinalAt = undefined;
    }
    this.liveText = transcript.text;
    if (transcript.final) this.liveFinalAt = this.now();
    if (transcript.final && this.pending && this.now() - this.pending.atMs <= this.matchMs) {
      this.answer(true);
      return;
    }
    const text = this.text();
    if (text && text !== this.emitted) {
      this.emitted = text;
      this.transcript(text, 'interim');
    }
  }

  private get matchMs(): number {
    return this.options.matchMs ?? 700;
  }

  /** The host's commit. A live final soon after answers it; else the model does. */
  commit(): void {
    if (this.pending) return;
    const at = this.now();
    // A commit a few ms behind the live one (the frame grid, a VAD stop a frame later) is the same
    // commit: the live final already in hand answers it.
    if (this.liveFinalAt !== undefined && at - this.liveFinalAt <= LATE_MS) {
      this.pending = { atMs: at, cancel: () => undefined };
      this.answer(true);
      return;
    }
    // The open live segment's final, or one of a segment whose first word is its final.
    const liveSoon = this.live.some(
      (t) =>
        t.final &&
        t.atMs >= at &&
        t.atMs - at <= this.matchMs &&
        (t.segmentId === this.liveSegment || !this.seen.has(t.segmentId)),
    );
    const wait = liveSoon ? this.matchMs + 1 : (this.options.commitLatencyMs ?? 320);
    this.pending = { atMs: at, cancel: this.clock.setTimeout(() => this.answer(false), wait) };
  }

  private answer(live: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    pending.cancel();
    this.pending = undefined;
    const text = this.text();
    if (text) this.transcript(text, 'final');
    this.onEvent({ type: 'end-of-turn' });
    this.options.onCommit?.({ atMs: pending.atMs, answeredAtMs: this.now(), live, text });
    this.segment++;
    this.carried = [];
    this.committedWords = words(this.liveText).length;
    this.emitted = '';
    this.liveFinalAt = undefined;
  }

  close(): void {
    this.pending?.cancel();
    for (const cancel of this.cancels.splice(0)) cancel();
  }
}

/** An `ovo.stt` port that replays `live` (call-time transcripts) on `clock`. */
export function scribeModel(
  clock: Clock,
  live: readonly Transcript[],
  options: ScribeModelOptions = {},
): SpeechToText {
  return {
    capabilities: SCRIBE_CAPABILITIES,
    async start(input) {
      const replay = new ScribeReplay(clock, live, input.onEvent, options);
      input.signal.addEventListener('abort', () => replay.close(), { once: true });
      const session: SttSession = {
        async write() {},
        async forceEndpoint() {
          replay.commit();
        },
        async finish() {
          replay.close();
        },
        async cancel() {
          replay.close();
        },
      };
      return session;
    },
  };
}
