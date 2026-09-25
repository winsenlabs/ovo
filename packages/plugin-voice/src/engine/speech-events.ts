import type { EngineEvent, SpeechEvidence, SpeechSegment } from '@winsendotai/ovo-contracts';
import type { SpeechTimingPhase } from '../speech/timing.ts';
import { VoiceEventBus } from './events.ts';
import { TurnLatency } from './latency.ts';

/** Projects scheduler evidence into the native engine event and timing streams. */
export class SpeechEventProjector {
  private readonly acknowledged = new Set<string>();
  private readonly segmentTurns = new Map<string, string>();
  private readonly syntheticTurns = new Set<string>();
  private readonly activeByEpoch = new Map<number, Set<string>>();

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
    if (evidence.phase === 'started') {
      const active = this.activeByEpoch.get(evidence.epoch) ?? new Set<string>();
      if (!active.size)
        this.bus.observe({
          type: 'bot.started',
          epoch: evidence.epoch,
          atMs: evidence.at,
          kind: evidence.kind as 'response',
        });
      active.add(evidence.segmentId);
      this.activeByEpoch.set(evidence.epoch, active);
    }
    if (
      evidence.phase === 'completed' ||
      evidence.phase === 'interrupted' ||
      evidence.phase === 'failed'
    ) {
      const active = this.activeByEpoch.get(evidence.epoch);
      if (active?.delete(evidence.segmentId) && !active.size) {
        this.activeByEpoch.delete(evidence.epoch);
        this.bus.observe({
          type: 'bot.stopped',
          epoch: evidence.epoch,
          atMs: evidence.at,
          kind: evidence.kind as 'response',
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
