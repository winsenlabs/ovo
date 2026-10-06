import type {
  EngineEvent,
  SpeechEvidence,
  SpeechKindV2,
  SpeechSegment,
} from '@winsendotai/ovo-contracts';
import type { SpeechTimingPhase } from '../speech/timing.ts';
import { VoiceEventBus } from './events.ts';
import { TurnLatency } from './latency.ts';

interface Line {
  epoch: number;
  kind: SpeechKindV2;
  question: boolean;
}

/** These protect caller input from the moment they are scheduled, before any audio. */
const PROTECTED = new Set<SpeechKindV2>(['confirmation', 'disclosure']);
const QUESTION = /[?？]["'”’)\s]*$/u;

/** Projects scheduler evidence into the native engine event and timing streams. */
export class SpeechEventProjector {
  private latestEpoch = -1;
  private readonly acknowledged = new Set<string>();
  private readonly segmentTurns = new Map<string, string>();
  private readonly syntheticTurns = new Set<string>();
  private readonly activeByEpoch = new Map<
    number,
    { segments: Set<string>; kind: SpeechKindV2; question: boolean }
  >();
  /** Lines scheduled while the agent is silent, still waiting for their first audio. */
  private readonly waiting = new Map<string, Line>();
  /**
   * The output reports when audio reaches the carrier ('sent'). Reporting is optional: until an
   * output has reported it, a line is taken to be audible from the moment it starts, as before.
   */
  private reportsAudio = false;

  constructor(
    private readonly bus: VoiceEventBus,
    private readonly latency: TurnLatency,
    private readonly turnForEpoch: (epoch: number) => string | undefined,
    private readonly emit: (event: EngineEvent) => void,
  ) {}

  onTiming(phase: SpeechTimingPhase, segment: SpeechSegment, elapsedMs = 0): void {
    if (phase === 'text-ready') {
      const selectedTurn = this.turnForEpoch(segment.epoch);
      const turnId = selectedTurn ?? `speech:${segment.id}`;
      this.segmentTurns.set(segment.id, turnId);
      if (!selectedTurn) {
        this.syntheticTurns.add(turnId);
        this.latency.startElapsed(turnId, elapsedMs);
      }
      this.latency.stage(turnId, 'text_aggregation', segment.id);
      return;
    }
    const turnId = this.segmentTurns.get(segment.id);
    if (!turnId) return;
    this.latency.stage(
      turnId,
      phase === 'tts-first-byte' ? 'tts_ttfb' : 'carrier_first_audio',
      segment.id,
    );
  }

  onSpeech(evidence: SpeechEvidence): void {
    this.emit({ type: 'speech', evidence });
    const turnId = this.segmentTurns.get(evidence.segmentId);
    if (turnId) {
      if (evidence.phase === 'acknowledged') {
        this.acknowledged.add(evidence.segmentId);
        this.latency.stage(turnId, 'playout_ack', evidence.segmentId);
      }
      if (evidence.phase === 'completed' && !this.acknowledged.has(evidence.segmentId))
        this.latency.stage(turnId, 'playout_ack', evidence.segmentId);
      if (
        evidence.phase === 'completed' ||
        evidence.phase === 'interrupted' ||
        evidence.phase === 'dropped' ||
        evidence.phase === 'failed'
      ) {
        if (this.syntheticTurns.has(turnId)) {
          if (evidence.phase === 'interrupted')
            this.latency.stage(turnId, 'bargein_latency', evidence.segmentId);
          this.latency.total(turnId);
          this.latency.clear(turnId);
          this.syntheticTurns.delete(turnId);
        }
        this.segmentTurns.delete(evidence.segmentId);
        this.acknowledged.delete(evidence.segmentId);
      }
    }
    if (evidence.phase === 'sent') this.reportsAudio = true;
    if (evidence.phase === 'started' && evidence.epoch >= this.latestEpoch) {
      const line: Line = {
        epoch: evidence.epoch,
        kind: evidence.kind as SpeechKindV2,
        question: QUESTION.test(evidence.text),
      };
      // AGT-9: the agent starts speaking when its audio reaches the carrier, not while the first
      // line is still being synthesised; a caller who talks during that wait is taking a turn. A
      // line scheduled inside a speaking interval keeps it going.
      if (!this.reportsAudio || this.activeByEpoch.has(line.epoch) || PROTECTED.has(line.kind))
        this.join(evidence.segmentId, line, evidence.at);
      else this.waiting.set(evidence.segmentId, line);
    }
    const waiting = this.waiting.get(evidence.segmentId);
    if (
      waiting &&
      (evidence.phase === 'sent' ||
        evidence.phase === 'acknowledged' ||
        evidence.phase === 'completed')
    ) {
      this.waiting.delete(evidence.segmentId);
      if (waiting.epoch >= this.latestEpoch) this.join(evidence.segmentId, waiting, evidence.at);
    }
    if (
      evidence.phase === 'completed' ||
      evidence.phase === 'interrupted' ||
      evidence.phase === 'failed'
    ) {
      this.waiting.delete(evidence.segmentId);
      const active = this.activeByEpoch.get(evidence.epoch);
      if (active?.segments.delete(evidence.segmentId) && !active.segments.size) {
        this.activeByEpoch.delete(evidence.epoch);
        this.bus.observe({
          type: 'bot.stopped',
          epoch: evidence.epoch,
          atMs: evidence.at,
          kind: active.kind,
        });
      }
    }
    if (
      evidence.phase === 'generated' ||
      evidence.phase === 'completed' ||
      evidence.phase === 'interrupted'
    )
      this.emit({
        type: 'agent.transcript',
        segmentId: evidence.segmentId,
        text: evidence.text,
        state:
          evidence.phase === 'generated'
            ? 'generated'
            : evidence.phase === 'completed'
              ? 'played'
              : 'interrupted',
      });
  }

  /** The line is audible (or protected): it opens or joins its epoch's speaking interval. */
  private join(segmentId: string, line: Line, atMs: number): void {
    if (line.epoch > this.latestEpoch) this.activeByEpoch.clear();
    this.latestEpoch = line.epoch;
    const { epoch, kind } = line;
    const active = this.activeByEpoch.get(epoch);
    // Overlapping playback shares one speaking interval. A response must never
    // unmute a confirmation/disclosure whose receipt is still outstanding.
    const protectedKind = active?.kind === 'confirmation' || active?.kind === 'disclosure';
    const promote =
      !active ||
      (!protectedKind && kind === 'confirmation') ||
      (active.kind !== 'disclosure' && kind === 'disclosure');
    const group = active ?? { segments: new Set<string>(), kind, question: false };
    group.segments.add(segmentId);
    if (promote) group.kind = kind;
    const asks = line.question && !group.question;
    group.question ||= line.question;
    this.activeByEpoch.set(epoch, group);
    if (promote || asks)
      this.bus.observe({
        type: 'bot.started',
        epoch,
        atMs,
        kind: group.kind,
        ...(group.question ? { question: true } : {}),
      });
  }
}
