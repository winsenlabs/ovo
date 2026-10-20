import type { TurnShadowEvent } from './model-shadow.ts';

/**
 * Process-wide counters of the model turn detector (every call of the worker, all agents): what
 * shadow mode saw, and how often the model was unavailable. The worker reads `snapshot()` into
 * `/health?verbose=1` and its slot report; per-turn detail is the `turn_shadow` log line.
 */
export class TurnShadowTelemetry {
  private counts = zero();

  record(event: TurnShadowEvent): void {
    const { counts } = this;
    counts.turns++;
    const { basis } = event.model;
    if (basis !== 'model' && basis !== 'broken-off') counts.noOpinion[basis]++;
    if (event.model.decision === 'end') counts.wouldEnd++;
    else counts.wouldHold++;
    counts.outcomes[event.outcome]++;
    if (event.outcome === 'released' || event.outcome === 'expired') counts.heldMs += event.afterMs;
  }

  /** The model failed to load (the agents get the rules until a later load works). */
  unavailable(): void {
    this.counts.modelUnavailable++;
  }

  /** A session was given the rules detector because the model is unavailable. */
  fellBack(): void {
    this.counts.sessionFallbacks++;
  }

  /** An active-mode reading failed or timed out: that turn ended as the rules decided. */
  fault(kind: 'timeout' | 'failure'): void {
    this.counts.faults[kind]++;
  }

  snapshot() {
    return structuredClone(this.counts);
  }

  reset(): void {
    this.counts = zero();
  }
}

function zero() {
  return {
    /** Turns the rules ended while a shadow detector watched. */
    turns: 0,
    wouldEnd: 0,
    wouldHold: 0,
    /** The model had no opinion (it did not cover the turn), by reason. */
    noOpinion: {
      'short-answer': 0,
      question: 0,
      language: 0,
      'no-audio': 0,
      timeout: 0,
      failure: 0,
    },
    /**
     * What came of the turns: `continued` a held turn the caller went on with (the rules split a
     * thought), `released` and `expired` a held turn that was not continued (the latency cost).
     */
    outcomes: { ended: 0, continued: 0, released: 0, expired: 0, abandoned: 0 },
    /** Milliseconds the held turns that were not continued would have waited. */
    heldMs: 0,
    modelUnavailable: 0,
    sessionFallbacks: 0,
    faults: { timeout: 0, failure: 0 },
  };
}

export const turnShadowTelemetry = new TurnShadowTelemetry();
