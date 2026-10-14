import { describe, expect, it } from 'vitest';
import type { Behavior, TurnSpeculation } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, sleep } from '../../eval/src/replay-kit/index.ts';

/**
 * Wave 12 (call 8cb76efc F2, turn 10), ms from turn 10's endpoint at 02:54:59.954 as the call's
 * engine events have it (/tmp/ovo/call7-events.jsonl): "Sometime around December to... January."
 * searched from 424 ms; "One moment." at 1,500 ms (played to 2,508); a soft interim "January."
 * (no VAD run, the end of turn 10's words again) opened turn 11 at 2,677 ms and gave up turn 10's
 * search and its answer, so the caller heard only "One moment."; turn 11's words became
 * "Jan 12th, 2024." at 3,784 ms and ended at 5,676 ms. The search answer's time is modelled
 * (4,500 ms, as call 7's other search answers).
 */
const FILLER = { text: 'One moment.', afterMs: 1500 };
const SAID = {
  turn10: 'Sometime around December to... January.',
  turn10Reply: 'Late December into January is a lovely time for Prague’s markets.',
  repeat: 'January.',
  turn11: 'Jan 12th, 2024.',
  turn11Reply: 'Noted, the 12th of January.',
};
const AT = { search: 424, repeat: 2677, turn11Words: 3784, turn11Stop: 5676, answer: 4500 };

function replay() {
  const clock = new FakeClock();
  const asked: string[] = [];
  let searched: ((atMs: number, signal: AbortSignal) => void) | undefined;
  const behavior: Behavior & TurnSpeculation = {
    respond: async () => '',
    async *respondStream(input, variables = {}) {
      if (variables.inputEvent === 'opening') {
        yield 'Hello, this is Maya.';
        return;
      }
      asked.push(input);
      const controller = new AbortController();
      if (input.includes('December')) {
        await sleep(clock, AT.search);
        searched?.(clock.now(), controller.signal);
        await sleep(clock, AT.answer - AT.search);
        yield SAID.turn10Reply;
        return;
      }
      await sleep(clock, 1000);
      yield SAID.turn11Reply;
    },
  };
  const h = driverHarness(clock, behavior, {
    ttsMs: 150,
    playMs: 2000,
    fillerPlayMs: 1008,
    fillers: [FILLER.text],
  });
  searched = (atMs, signal) =>
    h.driver.inferenceActivity({
      phase: 'started',
      tool: 'web_search',
      id: 'ws-1',
      atMs,
      signal,
      announce: undefined,
    } as never);
  return { clock, h, asked };
}

describe('call 8cb76efc turn 10: words that only repeat the end of the searched words', () => {
  it('give up no search: the caller hears turn 10’s answer, then turn 11’s', async () => {
    const { clock, h, asked } = replay();
    const t0 = await h.greet();
    h.turn.started('turn-10');
    h.turn.stopped('turn-10', SAID.turn10, FILLER);
    await clock.advanceAsync(AT.repeat);
    h.turn.started('turn-11');
    h.turn.partial('turn-11', SAID.repeat);
    await clock.advanceAsync(AT.turn11Words - AT.repeat);
    h.turn.partial('turn-11', SAID.turn11);
    await clock.advanceAsync(AT.turn11Stop - AT.turn11Words);
    h.turn.stopped('turn-11', SAID.turn11);
    await clock.advanceAsync(15_000);
    const heard = h.audio.map((line) => [line.text, line.atMs - t0]);
    // The answer is held while the caller still speaks (P1) and plays once turn 11 ends; live,
    // the merged turn searched again and answered with the uncertainty line from 7,266 ms.
    expect(heard).toEqual([
      [FILLER.text, FILLER.afterMs],
      [SAID.turn10Reply, AT.turn11Stop + 150],
      [SAID.turn11Reply, expect.any(Number)],
    ]);
    expect(h.cut).toEqual([]);
    // One search, never repeated: turn 11 is asked on its own words.
    expect(asked).toEqual([SAID.turn10, SAID.turn11]);
  });

  it('still gives the search up for brief words that carry the request on', async () => {
    const { clock, h, asked } = replay();
    await h.greet();
    h.turn.started('turn-10');
    h.turn.stopped('turn-10', SAID.turn10, FILLER);
    await clock.advanceAsync(AT.repeat);
    h.turn.started('turn-11');
    h.turn.partial('turn-11', 'Or February.');
    await clock.advanceAsync(AT.turn11Stop - AT.repeat);
    h.turn.stopped('turn-11', 'Or February.');
    await clock.advanceAsync(15_000);
    expect(asked).toEqual([SAID.turn10, `${SAID.turn10} Or February.`]);
  });
});
