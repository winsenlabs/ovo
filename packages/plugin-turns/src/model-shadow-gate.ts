import type { TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import { CallerAudio } from './caller-audio.ts';
import { TurnController } from './controller.ts';
import type {
  ControllerInput,
  EndOfTurnModel,
  ModelGateConfig,
  ModelGatedTurnController,
  ModelGateStats,
  SpeechStop,
} from './model-gate-config.ts';
import { emptyStats } from './model-reading.ts';
import { ShadowReader, type TurnShadowEvent } from './model-shadow.ts';

/**
 * The model detector in `shadow` mode: the rules detector decides every turn, and every decision
 * goes out exactly as the rules made it (same events, ids and timing). A model reads each turn the
 * rules end, on the side, and `onShadow` hears what it would have decided (model-shadow.ts). It
 * changes nothing in the call, so it is safe to run on live agents before `active`.
 */
export class ShadowGate implements ModelGatedTurnController {
  readonly stats: ModelGateStats = emptyStats();
  private readonly inner: TurnController;
  private readonly callerAudio: CallerAudio;
  private readonly reader: ShadowReader;
  private readonly inFlight = new Set<Promise<void>>();
  private startedAt = 0;
  private answering = false;
  private disposed = false;

  constructor(
    rules: unknown,
    gate: ModelGateConfig,
    model: EndOfTurnModel,
    private readonly input: ControllerInput,
    onShadow: (event: TurnShadowEvent) => void,
  ) {
    this.inner = new TurnController(rules, input);
    this.callerAudio = new CallerAudio(gate.audioMs);
    this.reader = new ShadowReader({
      model,
      gate,
      input,
      audio: this.callerAudio,
      stats: this.stats,
      inFlight: this.inFlight,
      answering: () => this.answering,
      report: onShadow,
    });
    this.inner.on((decision) => this.watch(decision));
  }

  observe(event: VoiceEvent): void {
    if (event.type === 'bot.started') this.answering = !!event.question;
    this.inner.observe(event);
  }

  on(fn: (decision: TurnDecision) => void): () => void {
    return this.inner.on(fn);
  }

  dispose(): void {
    this.disposed = true;
    this.reader.dispose();
    this.inner.dispose();
  }

  audio(pcm: Int16Array, rate: 8000 | 16000): void {
    if (!this.disposed) this.callerAudio.push(pcm, rate, this.input.clock.now());
  }

  agentSaid(): void {}

  async settled(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  /** Sees the rules' decisions (the listeners get them from the rules detector itself). */
  private watch(decision: TurnDecision): void {
    if (decision.type === 'turn.started') {
      this.reader.resumed();
      this.startedAt = this.input.clock.now();
    } else if (decision.type === 'turn.stopped' && decision.input.kind === 'speech') {
      this.reader.read(decision as SpeechStop, this.startedAt);
    }
  }
}
