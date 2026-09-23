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
}
