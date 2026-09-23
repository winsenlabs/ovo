import { sleep } from './runner.ts';
import {
  BOOKING,
  FAQ,
  LONG_ANSWER,
  PROMPT,
  promptSent,
  respondSeq,
  spoken,
  tool,
  type EngineScenario,
} from './engine-scenario-setup.ts';

/** Barge-in, confirmation receipts, dispose and hangup. */
export const SPEECH_SCENARIOS: readonly EngineScenario[] = [
  {
    name: 'barge-in clears media, interrupts the segment, and cancels pending marks before clear',
    setup: {
      agent: {
        ...FAQ,
        faq: [{ id: 'hours', question: 'What are your opening hours?', answer: LONG_ANSWER }],
      },
      tts: { msPerChar: 20 },
      carrier: { clearFlushesMarkers: true },
    },
    async run(h, f) {
      await h.say('what are your opening hours');
      await h.until(
        () => h.phases(/public holidays/).some((p) => p.phase === 'sent'),
        'the long answer to be sent',
      );
      await sleep(150);
      await h.say('stop talking please now');
      await h.until(
        () => h.receipts().some((r) => /public holidays/.test(r.receipt.text)),
        'the interrupted receipt',
      );
      const receipt = h.receipts().find((r) => /public holidays/.test(r.receipt.text))!.receipt;
      f.expect(receipt.state === 'interrupted', `the barged-in segment was ${receipt.state}`);
      f.expect(
        h.carrier.log.some((e) => e.type === 'clear'),
        'media was never cleared',
      );
      f.expect(
        h.events().some((e) => e.type === 'interrupt'),
        'no interrupt event',
      );
      f.expect(
        !h.phases(/public holidays/).some((p) => p.phase === 'completed'),
        'a cleared segment completed',
      );
      f.expect(
        h.carrier.log.some((e) => e.type === 'played' && e.flushed),
        'the carrier never flushed a pending mark (scenario inconclusive)',
      );
      const clearIndex = h.carrier.log.findIndex((e) => e.type === 'clear');
      const cancelIndex = h.carrier.log.findIndex((e) => e.type === 'mark-aborted');
      f.expect(
        cancelIndex >= 0 && cancelIndex < clearIndex,
        'pending mark was not cancelled before media.clear',
      );
    },
  },
  {
    name: 'a confirmed write executes exactly once after the prompt is heard',
    setup: { ...BOOKING, tts: { msPerChar: 2 } },
    async run(h, f) {
      await h.say('book a table for two');
      await h.until(
        () => h.receipts().some((r) => PROMPT.test(r.receipt.text)),
        'the confirmation prompt',
      );
      await h.say('yes');
      await h.until(() => spoken(h, /table is booked/), 'the booking answer');
      f.expect(h.executes().length === 1, `Execution.execute ran ${h.executes().length} times`);
      f.expect(h.executes()[0]?.request.confirmed === true, 'the write was not confirmed');
      const prompt = h.receipts().find((r) => PROMPT.test(r.receipt.text))!;
      f.expect(
        prompt.receipt.state === 'completed' && prompt.receipt.evidence === 'confirmed',
        'the prompt receipt is not completed+confirmed',
      );
    },
  },
  {
    name: 'an interrupted confirmation does not execute',
    setup: {
      ...BOOKING,
      hideSpeechKind: true,
      detector: { backchannels: [], minWordsWhileBotSpeaking: 1 },
    },
    async run(h, f) {
      await h.say('book a table for two');
      await h.until(() => promptSent(h), 'the confirmation prompt to play');
      await h.say('yes');
      const promptDone = () => h.receipts().some((r) => PROMPT.test(r.receipt.text));
      await h.until(
        () => respondSeq(h, /^yes$/i) !== undefined || promptDone(),
        "the 'yes' turn or the prompt's end",
      );
      await sleep(400);
      const yes = respondSeq(h, /^yes$/i);
      if (yes === undefined) {
        // The engine discarded 'yes' over what it saw as ordinary speech: nothing may execute.
        f.expect(
          h.executes().length === 0,
          "a write executed although 'yes' never reached the behavior",
        );
        return;
      }
      const before = h.receipts().filter((r) => r.seq < yes && PROMPT.test(r.receipt.text));
      const last = before.at(-1);
      if (!f.expect(last, "the prompt receipt was not delivered before the 'yes' turn")) return;
      if (last!.receipt.state === 'interrupted') {
        const heardLater = h
          .receipts()
          .find(
            (r) => r.seq > yes && PROMPT.test(r.receipt.text) && r.receipt.state === 'completed',
          );
        const executedEarly = h
          .executes()
          .filter((e) => e.seq > yes && (!heardLater || e.seq < heardLater.seq));
        f.expect(
          executedEarly.length === 0,
          'an interrupted confirmation prompt still executed the write',
        );
      }
    },
  },
  {
    name: "'yes' during the confirmation prompt waits for the prompt's receipt",
    setup: BOOKING,
    async run(h, f) {
      await h.say('book a table for two');
      await h.until(() => promptSent(h), 'the confirmation prompt to play');
      await h.say('yes');
      await h.until(() => h.executes().length > 0, 'the confirmed write', h.timeoutMs + 5000);
      const yes = respondSeq(h, /^yes$/i);
      const prompt = h.receipts().find((r) => PROMPT.test(r.receipt.text));
      f.expect(
        prompt?.receipt.state === 'completed',
        `the prompt receipt was ${prompt?.receipt.state ?? 'missing'}`,
      );
      f.expect(
        prompt && yes && prompt.seq < yes,
        "'yes' was dispatched before the prompt's receipt",
      );
      f.expect(h.executes().length === 1, `Execution.execute ran ${h.executes().length} times`);
    },
  },
  {
    name: 'dispose is bounded and idempotent',
    setup: { agent: FAQ },
    async run(h, f) {
      await h.stt.session(0);
      const started = Date.now();
      const [a, b] = await Promise.all([
        h.engine.dispose('drain', { deadlineMs: 500 }),
        h.engine.dispose('drain'),
      ]);
      const c = await h.engine.dispose('superseded');
      f.expect(Date.now() - started < 2500, `dispose took ${Date.now() - started} ms`);
      f.expect(
        JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c),
        'dispose returned different outcomes',
      );
      f.expect(
        a.reason === 'drain' && a.outcome === 'failed',
        `dispose outcome ${JSON.stringify(a)}`,
      );
      f.expect(
        JSON.stringify(await h.engine.ended) === JSON.stringify(a),
        'ended differs from dispose',
      );
      f.expect(h.carrier.closed, 'media was not closed');
      f.expect(
        h.events().filter((e) => e.type === 'end').length === 1,
        'end was not emitted exactly once',
      );
    },
  },
  {
    name: 'caller hangup ends the call as caller_ended',
    setup: { agent: FAQ },
    async run(h, f) {
      await h.stt.session(0);
      h.carrier.caller.hangup('caller_hangup');
      const outcome = await Promise.race([h.engine.ended, sleep(3000).then(() => undefined)]);
      f.expect(
        outcome?.reason === 'caller_hangup' && outcome.outcome === 'caller_ended',
        `ended with ${JSON.stringify(outcome)}`,
      );
    },
  },
];
