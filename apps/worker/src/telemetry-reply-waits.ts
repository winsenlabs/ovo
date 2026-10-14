import type { EngineEvent } from '@winsendotai/ovo-contracts';
import { CarrierRoundTrip } from './telemetry-carrier-rtt.ts';

/**
 * Where a turn's wait for its first reply audio went (Wave 8 fix 3), recorded as the `reply.waits`
 * stage. Each part starts where the one before it ends, so they add up to `firstAudioMs`. The turn
 * summary times `firstSegmentMs` from the reply starting and `firstAudioMs` from the caller's
 * last voiced audio, so subtracting them also counts the endpoint: the ~0.9 s "gap" of
 * latency-evidence C (call f3363705) was 0.77-0.84 s of endpointing and a 146 ms TTS first byte.
 */
export interface ReplyWaits {
  turnId: string;
  segmentId: string;
  /** The caller's last voiced audio (by the VAD), or the turn being taken, to first reply audio. */
  firstAudioMs: number;
  /** VAD stop to the turn being taken: the endpoint, less the VAD's hangover. */
  endpointMs: number;
  /** Turn taken to its reply starting: an earlier reply still running. */
  queueMs: number;
  /** Reply started to its first line: grounding, the decision, the LLM, text aggregation. */
  composeMs: number;
  /** First line ready to it being spoken: the filler it cuts flushing first (P3). */
  fillerCutMs: number;
  /** Spoken to playing: held while the caller spoke again (P1), or lines ahead of it. */
  startWaitMs: number;
  /** Playing to TTS first byte; 0 for a pre-rendered clip, or audio synthesised while held. */
  ttsFirstByteMs: number;
  /** TTS first byte to the carrier's first audio. */
  carrierMs: number;
  /** A filler's first audio, from the same start, when one played first. */
  fillerAudioMs: number | null;
  /**
   * Wave 12 (call 8cb76efc F2): the silence the caller heard before this reply, from the later of
   * their last voiced audio and the end of the agent's last line before it (a filler, or an
   * earlier reply this one queued behind), to its first audio. `firstAudioMs` counts every line
   * in between: call 8cb76efc turn 20 ("Please.", queued behind the reply to the words before it)
   * reported 11.8 s, of which the caller heard 2.2 s of silence.
   */
  heardSilenceMs: number;
  /**
   * Wave 9 D7: the carrier leg's round trip as this call last measured it from playback marks
   * (`telemetry-carrier-rtt.ts`), or null before a mark has measured it. Not one of the parts: the
   * caller hears the first audio about half of it after `firstAudioMs`, plus the phone network.
   */
  carrierRoundTripMs: number | null;
}

interface TurnMarks {
  start: number;
  acceptedAt?: number;
  decisionAt?: number;
  firstSegmentAt?: number;
  fillerAt?: number;
  done?: boolean;
}

interface LineMarks {
  turnId: string;
  readyAt: number;
  generatedAt?: number;
  startedAt?: number;
  ttsAt?: number;
  filler?: boolean;
}

/** Turns and lines that never reach audio (superseded, flushed) are dropped past these. */
const KEEP_TURNS = 16;
const KEEP_LINES = 64;
/** Speech evidence that a line's audio ended, played out or cut. */
const ENDED = new Set(['completed', 'interrupted']);

/** Folds engine timing and speech events into one `ReplyWaits` per turn, at its first reply audio. */
export class ReplyWaitClock {
  private readonly turns = new Map<string, TurnMarks>();
  private readonly lines = new Map<string, LineMarks>();
  private readonly carrier = new CarrierRoundTrip();
  /** Lines whose audio has started and not yet ended (Wave 12, `heardSilenceMs`). */
  private readonly playing = new Set<string>();
  /** When the agent's last line that played ended. */
  private heardUntil?: number;

  constructor(private readonly record: (waits: ReplyWaits) => void) {}

  engine(event: EngineEvent): void {
    if (event.type === 'speech') {
      this.carrier.speech(event.evidence);
      return this.speech(event.evidence);
    }
    if (event.type !== 'timing' || !event.turnId) return;
    const { key, turnId, segmentId, atMs } = event;
    let turn = this.turns.get(turnId);
    if (!turn) {
      // As the turn summary does: the turn starts where its first timing's interval began.
      turn = { start: atMs - (event.ms ?? 0) };
      keep(this.turns, turnId, turn, KEEP_TURNS);
    }
    if (key === 'turn_decision') {
      turn.decisionAt = atMs;
      turn.acceptedAt = atMs - (event.ms ?? 0);
    } else if (key === 'behavior_first_segment') turn.firstSegmentAt ??= atMs;
    else if (!segmentId) return;
    else if (key === 'text_aggregation')
      keep(this.lines, segmentId, { turnId, readyAt: atMs }, KEEP_LINES);
    else if (key === 'tts_ttfb') {
      const line = this.lines.get(segmentId);
      if (line) line.ttsAt ??= atMs;
    } else if (key === 'carrier_first_audio') this.audio(turn, segmentId, atMs);
  }

  /** A line's audio length, once its synthesis ended, for the carrier round trip. */
  lineAudio(segmentId: string, audioMs: number): void {
    this.carrier.audio(segmentId, audioMs);
  }

  private speech(evidence: Extract<EngineEvent, { type: 'speech' }>['evidence']): void {
    if (evidence.phase === 'sent' || evidence.phase === 'started') {
      this.playing.add(evidence.segmentId);
      if (this.playing.size > KEEP_LINES) this.playing.delete(this.playing.values().next().value!);
    } else if (ENDED.has(evidence.phase) && this.playing.delete(evidence.segmentId))
      this.heardUntil = Math.max(this.heardUntil ?? evidence.at, evidence.at);
    const line = this.lines.get(evidence.segmentId);
    if (!line) return;
    // A LAT-6 filler, a search line or "still checking": no answer.
    if (evidence.kind === 'acknowledgment') line.filler = true;
    if (evidence.phase === 'generated') line.generatedAt ??= evidence.at;
    // The latest start counts: a line taken back for the caller (P1) starts again on release.
    else if (evidence.phase === 'started') line.startedAt = evidence.at;
  }

  private audio(turn: TurnMarks, segmentId: string, at: number): void {
    const line = this.lines.get(segmentId);
    this.lines.delete(segmentId);
    if (!line || turn.done) return;
    if (line.filler) {
      turn.fillerAt ??= at;
      return;
    }
    if (turn.decisionAt === undefined || turn.acceptedAt === undefined) return;
    turn.done = true;
    const composed = Math.max(turn.decisionAt, turn.firstSegmentAt ?? line.readyAt);
    const ready = Math.max(composed, line.generatedAt ?? line.readyAt);
    const started = Math.max(ready, line.startedAt ?? ready);
    const tts = Math.min(at, Math.max(started, line.ttsAt ?? started));
    this.record({
      turnId: line.turnId,
      segmentId,
      firstAudioMs: at - turn.start,
      endpointMs: turn.acceptedAt - turn.start,
      queueMs: turn.decisionAt - turn.acceptedAt,
      composeMs: composed - turn.decisionAt,
      fillerCutMs: ready - composed,
      startWaitMs: started - ready,
      ttsFirstByteMs: tts - started,
      carrierMs: at - tts,
      fillerAudioMs: turn.fillerAt === undefined ? null : turn.fillerAt - turn.start,
      heardSilenceMs: Math.max(0, at - Math.max(turn.start, this.heardUntil ?? turn.start)),
      carrierRoundTripMs: this.carrier.estimateMs,
    });
  }
}

function keep<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}
