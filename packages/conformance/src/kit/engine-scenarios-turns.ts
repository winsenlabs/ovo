import { sleep } from './runner.ts';
import { FAQ, spoken, tool, type EngineScenario } from './engine-scenario-setup.ts';

/** Modes, tools, DTMF and variables. */
export const TURN_SCENARIOS: readonly EngineScenario[] = [
  {
    name: 'announcement plays without input and completes',
    setup: {
      agent: {
        mode: 'announcement',
        message: 'Hello {{customer}}, your appointment is tomorrow at ten.',
        variables: {
          type: 'object',
          properties: { customer: { type: 'string' } },
          required: ['customer'],
        },
      },
    },
    async run(h, f) {
      const outcome = await Promise.race([
        h.engine.ended,
        sleep(h.timeoutMs).then(() => undefined),
      ]);
      f.expect(
        outcome?.reason === 'behavior_completed',
        `ended with ${outcome?.reason ?? 'nothing'}`,
      );
      f.expect(outcome?.outcome === 'completed', `outcome ${outcome?.outcome ?? 'none'}`);
      f.expect(
        h.tts.texts.includes('Hello Asha, your appointment is tomorrow at ten.'),
        'the rendered announcement was not spoken',
      );
      f.expect(h.stt.sessions.length === 0, 'an announcement without input opened an STT session');
    },
  },
  {
    name: 'FAQ answers without an LLM',
    setup: { agent: FAQ },
    async run(h, f) {
      await h.say('what are your opening hours');
      await h.until(() => spoken(h, /nine to five/), 'the FAQ answer');
      f.expect(
        h.carrier.log.some((e) => e.type === 'audio'),
        'no audio reached the carrier',
      );
    },
  },
  {
    name: 'context answers from supplied context with a scripted Inference',
    setup: {
      agent: { mode: 'context', context: 'The office is in Pune.' },
      replies: [{ kind: 'text', text: 'The office is in Pune.' }],
    },
    async run(h) {
      await h.say('where is the office');
      await h.until(() => spoken(h, /Pune/), 'the context answer');
    },
  },
  {
    name: 'agent tools run through Execution; progress speech goes through ovo.speech and the engine media path',
    setup: {
      agent: { mode: 'agent', tools: [tool('balance', 'read')], allowedTools: ['balance'] },
      replies: [
        { kind: 'tool', toolId: 'balance', input: { account: 'A-1' } },
        { kind: 'text', text: 'Your balance is 42 rupees.' },
      ],
      progress: 'Please wait while I check that.',
    },
    async run(h, f) {
      await h.say('what is my balance');
      await h.until(
        () => h.receipts().some((r) => /balance is 42/.test(r.receipt.text)),
        'the tool answer',
      );
      f.expect(h.executes().length === 1, `Execution.execute ran ${h.executes().length} times`);
      f.expect(h.executes()[0]?.request.confirmed === false, 'a read tool was marked confirmed');
      const progress = h.log.find((e) => e.kind === 'progress');
      f.expect(
        progress?.kind === 'progress' && progress.receipt.state === 'completed',
        'progress speech did not complete through ovo.speech',
      );
      f.expect(
        h.phases(/Please wait/).some((p) => p.kind === 'progress'),
        'progress speech is not a progress segment of the engine',
      );
      f.expect(
        h.tts.texts.includes('Please wait while I check that.'),
        'progress speech never reached TTS',
      );
      const order = h
        .events()
        .flatMap((e) => (e.type === 'agent.transcript' && e.state === 'generated' ? [e.text] : []));
      f.expect(
        order.indexOf('Please wait while I check that.') <
          order.findIndex((t) => /balance is 42/.test(t)),
        'progress was not spoken before the answer',
      );
    },
  },
  {
    name: 'DTMF digits reach the behavior with the session variables',
    setup: { agent: FAQ },
    async run(h, f) {
      await h.stt.session(0);
      for (const digit of '12#') h.carrier.caller.dtmf(digit);
      await h.until(
        () => h.responds().some((r) => r.input.includes('12') || r.variables.digits === '12'),
        'a DTMF turn',
      );
      const turn = h.responds().find((r) => r.input.includes('12') || r.variables.digits === '12');
      f.expect(turn?.variables.customer === 'Asha', 'the DTMF turn lost the session variables');
    },
  },
  {
    name: 'variables reach every behavior call (initial, speech and DTMF turns)',
    setup: { agent: FAQ, session: { initialInput: 'hello' } },
    async run(h, f) {
      await h.until(() => h.responds().length >= 1, 'the initial turn');
      await h.until(() => h.receipts().length >= 1, 'the initial reply');
      await h.say('what are your opening hours');
      await h.until(() => h.responds().length >= 2, 'the speech turn');
      await h.until(() => h.receipts().length >= 2, 'the speech reply');
      for (const digit of '7#') h.carrier.caller.dtmf(digit);
      await h.until(() => h.responds().length >= 3, 'the DTMF turn');
      f.expect(h.responds().length >= 3, 'expected three behavior calls');
    },
  },
];
