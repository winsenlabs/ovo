import type {
  EngineEvent,
  SpeechEvidence,
  SpeechKindV2,
  SpeechSegment,
} from '@winsendotai/ovo-contracts';
import type { SpeechTimingPhase } from '../speech/timing.ts';
import { VoiceEventBus } from './events.ts';
import { TurnLatency } from './latency.ts';

/** Projects scheduler evidence into the native engine event and timing streams. */
export class SpeechEventProjector {
  private latestEpoch = -1;
  private readonly acknowledged = new Set<string>();
  private readonly segmentTurns = new Map<string, string>();
  private readonly syntheticTurns = new Set<string>();
  private readonly activeByEpoch = new Map<number, { segments: Set<string>; kind: SpeechKindV2 }>();

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
    if (evidence.phase === 'started' && evidence.epoch >= this.latestEpoch) {
      if (evidence.epoch > this.latestEpoch) this.activeByEpoch.clear();
      this.latestEpoch = evidence.epoch;
      const kind = evidence.kind as SpeechKindV2;
      const active = this.activeByEpoch.get(evidence.epoch);
      // Overlapping playback shares one speaking interval. A response must never
      // unmute a confirmation/disclosure whose receipt is still outstanding.
      const protectedKind = active?.kind === 'confirmation' || active?.kind === 'disclosure';
      const promote =
        !active ||
        (!protectedKind && kind === 'confirmation') ||
        (active.kind !== 'disclosure' && kind === 'disclosure');
      const group = active ?? { segments: new Set<string>(), kind };
      group.segments.add(evidence.segmentId);
      if (promote) group.kind = kind;
      this.activeByEpoch.set(evidence.epoch, group);
      if (promote)
        this.bus.observe({ type: 'bot.started', epoch: evidence.epoch, atMs: evidence.at, kind });
    }
    if (
      evidence.phase === 'completed' ||
      evidence.phase === 'interrupted' ||
      evidence.phase === 'failed'
    ) {
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
}
