import type { EndpointRule } from '@winsendotai/ovo-contracts';
import { countWords } from '@winsendotai/ovo-contracts';
import type { CallerAudio } from './caller-audio.ts';
import type {
  ControllerInput,
  EndOfTurnModel,
  ModelGateConfig,
  ModelGateStats,
  SpeechStop,
} from './model-gate-config.ts';
import { predict, safetyRead } from './model-reading.ts';

/** Why the model would have decided as it did (`model` when it read the turn). */
export type ShadowBasis =
  | 'model'
  | 'short-answer'
  | 'question'
  | 'language'
  | 'no-audio'
  | 'timeout'
  | 'failure'
  | 'broken-off';

/**
 * What the model would have done to one turn the rules ended, beside what the rules did. Shadow mode
 * changes nothing in the call: the rules ended the turn at `rules`, and this records the model’s
 * view of it (no transcript text: the words stay in the call’s own events).
 *
 * `outcome`: `ended` the model would have ended it too; `continued` it would have held the turn and
 * the caller did go on within the hold (the rules split one thought: the case a model detector
 * exists for); `released` it would have held, then read the turn as finished `afterMs` later;
 * `expired` it would have held for all of holdMs and the caller did not go on (pure added latency);
 * `abandoned` the call ended first.
 */
export interface TurnShadowEvent {
  turnId: string;
  language: string;
  rules: { reason?: EndpointRule; words: number; segments: number };
  model: {
    name: string;
    threshold?: number;
    probability?: number;
    decision: 'end' | 'hold';
    basis: ShadowBasis;
    /** Probabilities of the readings of the held turn as the silence grew (recheckMs). */
    rechecks: number[];
  };
  outcome: 'ended' | 'continued' | 'released' | 'expired' | 'abandoned';
  /** Milliseconds from the rules’ stop to the outcome (0 for a turn the model would end at once). */
  afterMs: number;
}

interface Active {
  event: TurnShadowEvent;
  text: string;
  startedAt: number;
  stopAt: number;
  threshold: number;
  phase: 'reading' | 'held';
  resumed: boolean;
  cancels: (() => void)[];
}

/**
 * The model gate’s shadow mode: reads each turn the rules end, as the gate would, and reports what it
 * would have decided once that is known. At most one turn is evaluated at a time.
 */
export class ShadowReader {
  private active?: Active;
  private text = '';

  constructor(
    private readonly options: {
      model: EndOfTurnModel;
      gate: ModelGateConfig;
      input: ControllerInput;
      audio: CallerAudio;
      stats: ModelGateStats;
      inFlight: Set<Promise<void>>;
      answering: () => boolean;
      report: (event: TurnShadowEvent) => void;
    },
  ) {}

  /** The rules ended `stop` (the turn started at `startedAt` on the clock). */
  read(stop: SpeechStop, startedAt: number): void {
    const { model, gate, input, stats } = this.options;
    this.close('abandoned');
    stats.stops++;
    const language = input.language;
    const text = stop.input.text;
    this.text = text;
    const event: TurnShadowEvent = {
      turnId: stop.turnId,
      language,
      rules: {
        ...(stop.reason ? { reason: stop.reason } : {}),
        words: countWords(text, language),
        segments: stop.input.segments,
      },
      model: { name: model.name, decision: 'end', basis: 'model', rechecks: [] },
      outcome: 'ended',
      afterMs: 0,
    };
    const covered = model.threshold(language);
    if (covered === undefined) return this.end(event, 'language');
    const threshold = gate.threshold ?? covered;
    event.model.threshold = threshold;
    const { bypass, brokenOff } = safetyRead(text, gate.safety, {
      language,
      answering: this.options.answering(),
    });
    if (bypass) return this.end(event, bypass === 'question' ? 'question' : 'short-answer');
    const stopAt = input.clock.now();
    const audio = this.options.audio.since(startedAt - gate.preRollMs);
    if (model.input === 'audio' && !audio) {
      stats.bypassed.noAudio++;
      return brokenOff
        ? this.hold(event, startedAt, stopAt, threshold, 'broken-off')
        : this.end(event, 'no-audio');
    }
    const active = this.begin(event, startedAt, stopAt, threshold, 'reading');
    active.cancels.push(
      input.clock.setTimeout(() => {
        if (this.active !== active) return;
        stats.timeouts++;
        this.verdict(active, undefined, brokenOff ? 'broken-off' : 'timeout', brokenOff);
      }, gate.timeoutMs),
    );
    predict(
      model,
      { text, language, ...(audio ? { audio } : {}) },
      this.options.inFlight,
      (probability) => {
        if (this.active !== active) return;
        stats.predictions.push(probability);
        this.verdict(active, probability, brokenOff ? 'broken-off' : 'model', brokenOff);
      },
      () => {
        if (this.active !== active) return;
        stats.failures++;
        this.verdict(active, undefined, brokenOff ? 'broken-off' : 'failure', brokenOff);
      },
    );
  }

  /** The caller started speaking again. */
  resumed(): void {
    const active = this.active;
    if (!active) return;
    if (active.phase === 'held') this.finish(active, 'continued');
    else active.resumed = true;
  }

  dispose(): void {
    this.close('abandoned');
  }

  private begin(
    event: TurnShadowEvent,
    startedAt: number,
    stopAt: number,
    threshold: number,
    phase: Active['phase'],
  ): Active {
    const active: Active = {
      event,
      text: this.text,
      startedAt,
      stopAt,
      threshold,
      phase,
      resumed: false,
      cancels: [],
    };
    this.active = active;
    return active;
  }

  private verdict(
    active: Active,
    probability: number | undefined,
    basis: ShadowBasis,
    brokenOff: boolean,
  ): void {
    const { event } = active;
    active.cancels.splice(0).forEach((cancel) => cancel());
    if (probability !== undefined) event.model.probability = probability;
    event.model.basis = basis;
    const finished = probability !== undefined && probability >= active.threshold && !brokenOff;
    if (finished || (probability === undefined && !brokenOff)) {
      event.afterMs = this.options.input.clock.now() - active.stopAt;
      return this.finish(active, 'ended');
    }
    this.hold(event, active.startedAt, active.stopAt, active.threshold, basis, active, brokenOff);
  }

  private hold(
    event: TurnShadowEvent,
    startedAt: number,
    stopAt: number,
    threshold: number,
    basis: ShadowBasis,
    current?: Active,
    brokenOff = true,
  ): void {
    const { input, gate, stats } = this.options;
    const active = current ?? this.begin(event, startedAt, stopAt, threshold, 'held');
    active.phase = 'held';
    event.model.decision = 'hold';
    event.model.basis = basis;
    stats.held.push(active.text);
    if (active.resumed) return this.finish(active, 'continued');
    active.cancels.push(input.clock.setTimeout(() => this.finish(active, 'expired'), gate.holdMs));
    if (!brokenOff && gate.recheckMs && this.options.model.input === 'audio') this.recheck(active);
  }

  private recheck(active: Active): void {
    const { model, gate, input, stats } = this.options;
    active.cancels.push(
      input.clock.setTimeout(() => {
        if (this.active !== active || active.phase !== 'held') return;
        const audio = this.options.audio.since(active.startedAt - gate.preRollMs);
        const settle = (probability: number) => {
          if (this.active !== active || active.phase !== 'held') return;
          stats.rechecks.push(probability);
          active.event.model.rechecks.push(probability);
          if (probability < active.threshold) return this.recheck(active);
          stats.released++;
          this.finish(active, 'released');
        };
        // A failed reading changes nothing: the hold runs out as it would have.
        predict(
          model,
          { text: active.text, language: input.language, ...(audio ? { audio } : {}) },
          this.options.inFlight,
          settle,
          () => {},
        );
      }, gate.recheckMs),
    );
  }

  private end(event: TurnShadowEvent, basis: ShadowBasis): void {
    if (basis === 'short-answer') this.options.stats.bypassed.shortAnswer++;
    else if (basis === 'question') this.options.stats.bypassed.question++;
    else if (basis === 'language') this.options.stats.bypassed.language++;
    event.model.basis = basis;
    this.options.report(event);
  }

  private finish(active: Active, outcome: TurnShadowEvent['outcome']): void {
    if (this.active !== active) return;
    this.active = undefined;
    active.cancels.splice(0).forEach((cancel) => cancel());
    if (outcome === 'continued') this.options.stats.merged++;
    active.event.outcome = outcome;
    if (outcome !== 'ended') active.event.afterMs = this.options.input.clock.now() - active.stopAt;
    this.options.report(active.event);
  }

  private close(outcome: 'abandoned'): void {
    const active = this.active;
    if (active) this.finish(active, outcome);
  }
}
