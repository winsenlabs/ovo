import { describe, expect, it } from 'vitest';
import { describeTurnDetector } from '@winsendotai/ovo-conformance';
import { createModelTurnDetector } from '../src/index.ts';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { fakeModel, gateFixture, syncModel } from './model-gate-fixture.ts';

const fixture = gateFixture(() => new FakeClock());

describeTurnDetector('model gate (a model that reads every turn as finished)', () =>
  createModelTurnDetector({}, syncModel(1)),
);

/**
 * With a model that holds every turn, turn@1 holds except where a check expects a speech turn to
 * end the moment the rules end it (provider end-of-turn, a "no" released at bot.stopped, the VAD
 * timeout, a VAD stop before any transcript, speech resuming before the timeout): the gate delays
 * that turn.stopped by up to holdMs, which is what it is for.
 */
describeTurnDetector(
  'model gate (a model that holds every turn)',
  () => createModelTurnDetector({}, syncModel(0)),
  {
    only: [
      'a long utterance barges in',
      'a backchannel while the bot speaks',
      "'yes' during the confirmation prompt",
      "a random 'hello' during the prompt",
      'answers are never backchannels',
      'during tools speech is discarded',
      'a turn already under way when a tool starts',
      'announcement mode never barges in',
      'a disclosure segment is always muted',
      'DTMF digits collect',
      'idle prompts after silence',
      'the explicit provider strategy ignores the VAD timeout',
    ],
  },
);

describe('model gate: the transcript doubt (Wave 8) of a turn joined in a hold', () => {
  it('keeps the doubt over held words the STT doubted when the caller goes on', async () => {
    const model = fakeModel(({ text }) => (text.endsWith('Friday.') ? 0.1 : 0.9));
    const f = fixture(model);
    f.say('Book the flight to Brandon Bakhtar on Friday.', 800, 0.2);
    await f.wait(1500);
    expect(f.stops()).toEqual([]);
    f.say('And charge my card please.', 800, 0.95);
    await f.wait(1000);
    expect(f.stops().map((s) => s.text)).toEqual([
      'Book the flight to Brandon Bakhtar on Friday. And charge my card please.',
    ]);
    expect(f.untrusted()).toEqual(['low-confidence']);
    // And a doubted continuation of trusted held words.
    const g = fixture(fakeModel(({ text }) => (text.endsWith('Friday.') ? 0.1 : 0.9)));
    g.say('Book the flight to Berlin on Friday.', 800, 0.95);
    await g.wait(1500);
    g.say('And charge my card please.', 800, 0.2);
    await g.wait(1000);
    expect(g.stops()).toHaveLength(1);
    expect(g.untrusted()).toEqual(['low-confidence']);
  });

  it('does not doubt all the words for a fragment the caller went on with', async () => {
    const f = fixture(fakeModel(0.1));
    f.say('I would like to book a flight.', 800, 0.95);
    await f.wait(1500);
    expect(f.stops()).toEqual([]);
    // Alone, "Berlin and..." is a fragment (Wave 8); after the held words it is not.
    f.say('Berlin and...', 800, 0.95);
    await f.wait(8000);
    expect(f.stops()).toEqual([
      { text: 'I would like to book a flight. Berlin and...', reason: 'hold' },
    ]);
    expect(f.untrusted()).toEqual([undefined]);
    const alone = fixture(fakeModel(0.1), { model: { holdMs: 1000 } });
    alone.say('Berlin and...', 800, 0.95);
    await alone.wait(8000);
    expect(alone.untrusted()).toEqual(['fragment']);
  });
});
