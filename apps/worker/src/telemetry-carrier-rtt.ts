import { bytesPerSecond, type AudioFormat, type SpeechEvidence } from '@winsendotai/ovo-contracts';

/**
 * Wave 9 D7: the carrier leg's round trip, estimated from playback marks. A carrier with
 * carrier-played evidence returns a line's mark once the audio before it has played (the source
 * is cited in `call5-carrier-round-trip.test.ts`). TTS sends audio faster than it plays, so for a line sent while nothing else was waiting on its mark,
 * the mark comes back its audio's length after the first audio left, plus the trip to the carrier,
 * the carrier's buffering and the mark's trip back: that remainder is the estimate. On Maya call
 * 10d5ef30 every such line gave 255–319 ms (speech-22: mark 2973 ms after send, 2703 ms of audio).
 * The carrier's own leg to the phone (the US number to an Indian mobile) is not in it: no mark sees
 * that far.
 */
interface Line {
  sentAt: number;
  /** No earlier line was still waiting on its mark when this one was sent. */
  idle: boolean;
  ackAt?: number;
  audioMs?: number;
}

/** A mark back sooner than its audio (a flushed line) or this late is not a playback. */
const MAX_PLAUSIBLE_MS = 5_000;
const KEEP_LINES = 64;
/** The estimate is the median of the latest measures, so one stalled mark does not move it. */
const KEEP_MEASURES = 5;

/**
 * A completed line's audio length from its `speech.cache` event, in the call's media format; the
 * event carries the line's bytes, not its format.
 */
export function speechCacheAudio(
  payload: Record<string, unknown>,
  format: AudioFormat | undefined,
): { segmentId: string; audioMs: number } | undefined {
  const { segmentId, bytes, outcome } = payload;
  if (!format || outcome !== 'completed') return undefined;
  if (typeof segmentId !== 'string' || typeof bytes !== 'number') return undefined;
  return { segmentId, audioMs: (bytes / bytesPerSecond(format)) * 1_000 };
}

export class CarrierRoundTrip {
  private readonly lines = new Map<string, Line>();
  private readonly unacknowledged = new Set<string>();
  private readonly measures: number[] = [];

  /** The call's latest estimate, in ms, or null until a line has measured it. */
  get estimateMs(): number | null {
    if (!this.measures.length) return null;
    const sorted = [...this.measures].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  speech(evidence: SpeechEvidence): void {
    const { segmentId, phase, at } = evidence;
    if (phase === 'sent') {
      this.lines.set(segmentId, { sentAt: at, idle: this.unacknowledged.size === 0 });
      if (this.lines.size > KEEP_LINES) this.lines.delete(this.lines.keys().next().value!);
      this.unacknowledged.add(segmentId);
      return;
    }
    if (phase === 'acknowledged') {
      this.unacknowledged.delete(segmentId);
      const line = this.lines.get(segmentId);
      // Only a carrier's own mark times playback; an estimated one is a timer.
      if (line && evidence.evidence === 'confirmed') {
        line.ackAt = at;
        this.measure(segmentId, line);
      } else this.lines.delete(segmentId);
      return;
    }
    if (
      phase === 'completed' ||
      phase === 'interrupted' ||
      phase === 'dropped' ||
      phase === 'failed'
    )
      this.unacknowledged.delete(segmentId);
    if (phase === 'interrupted' || phase === 'dropped' || phase === 'failed')
      this.lines.delete(segmentId);
  }

  /** The length of a line's audio, once it is known (its speech cache event). */
  audio(segmentId: string, audioMs: number): void {
    const line = this.lines.get(segmentId);
    if (!line || !Number.isFinite(audioMs) || audioMs <= 0) return;
    line.audioMs = audioMs;
    this.measure(segmentId, line);
  }

  private measure(segmentId: string, line: Line): void {
    if (line.ackAt === undefined || line.audioMs === undefined) return;
    this.lines.delete(segmentId);
    if (!line.idle) return;
    const ms = line.ackAt - line.sentAt - line.audioMs;
    if (ms < 0 || ms > MAX_PLAUSIBLE_MS) return;
    this.measures.push(Math.round(ms));
    if (this.measures.length > KEEP_MEASURES) this.measures.shift();
  }
}
