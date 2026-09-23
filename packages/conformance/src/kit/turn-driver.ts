import type { SpeechKindV2, TurnDecision, UserTurnController } from '@winsendotai/ovo-contracts';
import type { FakeClock } from '../drivers/fake-clock.ts';

/** Drives a UserTurnController with STT, bot, tool/confirmation and DTMF events on a FakeClock. */
export class Driver {
  readonly decisions: TurnDecision[] = [];
  private revision = 0;
  private segment = 0;
  private epoch = 0;

  constructor(
    readonly controller: UserTurnController,
    readonly clock: FakeClock,
  ) {
    controller.on((decision) => this.decisions.push(decision));
  }

  say(text: string, endOfTurn = true): void {
    const at = this.clock.now();
    const segmentId = `seg-${++this.segment}`;
    const observe = this.controller.observe.bind(this.controller);
    observe({ type: 'stt', event: { type: 'speech-start' }, atMs: at });
    const words = text.split(/\s+/);
    for (let i = 1; i < words.length; i += 1)
      observe({
        type: 'stt',
        atMs: at,
        event: {
          type: 'transcript',
          segment: {
            segmentId,
            revision: ++this.revision,
            text: words.slice(0, i).join(' '),
            stability: 'interim',
          },
        },
      });
    observe({
      type: 'stt',
      atMs: at,
      event: {
        type: 'transcript',
        segment: { segmentId, revision: ++this.revision, text, stability: 'final' },
      },
    });
    if (endOfTurn) observe({ type: 'stt', event: { type: 'end-of-turn' }, atMs: at });
  }

  vadStart(): void {
    this.controller.observe({ type: 'vad.start', atMs: this.clock.now() });
  }

  vadStop(): void {
    this.controller.observe({ type: 'vad.stop', atMs: this.clock.now() });
  }

  botStarts(kind: SpeechKindV2 = 'response'): void {
    this.controller.observe({
      type: 'bot.started',
      epoch: ++this.epoch,
      kind,
      atMs: this.clock.now(),
    });
  }

  botStops(kind: SpeechKindV2 = 'response'): void {
    this.controller.observe({
      type: 'bot.stopped',
      epoch: this.epoch,
      kind,
      atMs: this.clock.now(),
    });
  }

  signal(
    type: 'tool.started' | 'tool.settled' | 'confirmation.pending' | 'confirmation.resolved',
  ): void {
    this.controller.observe({ type, atMs: this.clock.now() });
  }

  dtmf(digits: string): void {
    for (const digit of digits)
      this.controller.observe({ type: 'dtmf', digit, atMs: this.clock.now() });
  }

  stopped(): { kind: string; text: string }[] {
    return this.decisions.flatMap((d) =>
      d.type === 'turn.stopped'
        ? [
            d.input.kind === 'speech'
              ? { kind: 'speech', text: d.input.text }
              : { kind: 'dtmf', text: d.input.digits },
          ]
        : [],
    );
  }

  interrupts(): number {
    return this.decisions.filter((d) => d.type === 'interrupt').length;
  }

  /** turn.reset reasons seen so far (§2.7 'muted' and 'backchannel'). */
  resets(): string[] {
    return this.decisions.flatMap((d) => (d.type === 'turn.reset' ? [d.reason] : []));
  }

  forceEndpoints(): number {
    return this.decisions.filter((d) => d.type === 'force-endpoint').length;
  }

  /**
   * Every turn the detector ends or resets must have been announced first (#F21): suppressing
   * `turn.started` hides the user turn from telemetry and from the engine's barge-in bookkeeping.
   */
  startedFailures(): string[] {
    const started = new Set<string>();
    const out: string[] = [];
    for (const decision of this.decisions) {
      if (decision.type === 'turn.started') {
        if (started.has(decision.turnId)) out.push(`turn ${decision.turnId} started twice`);
        started.add(decision.turnId);
      } else if (decision.type === 'turn.stopped' || decision.type === 'turn.reset')
        if (!started.has(decision.turnId))
          out.push(`${decision.type} for ${decision.turnId} without a turn.started`);
    }
    return out;
  }
}
