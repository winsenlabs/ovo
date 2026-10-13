import { describe, expect, it } from 'vitest';
import { TurnAnnouncer } from '../src/announce.ts';

/**
 * Wave 10 (call 4f1a919d, L3): turn 11, "No, okay, I'll take it later. Thank you so much.", closed
 * the call, yet the detector offered "One moment." with it. The engine no longer plays a filler
 * for a closing decline (`endsConversation`); the detector no longer offers one either.
 */
describe('call 4f1a919d L3: no filler offered with a closing decline', () => {
  const announcer = () =>
    new TurnAnnouncer({ lines: ['One moment.'], afterMs: 1500 }, () => undefined);

  it('turn 11: a no with thanks that puts it off is offered no filler', () => {
    expect(announcer().nextFiller("No, okay, I'll take it later. Thank you so much.")).toBe(
      undefined,
    );
  });

  it('a question still is (turn 6)', () => {
    expect(announcer().nextFiller('What is, uh, best way to fly to Europe from Chennai?')).toEqual({
      text: 'One moment.',
      afterMs: 1500,
    });
  });
});
