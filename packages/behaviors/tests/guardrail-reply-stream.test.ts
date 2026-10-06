import { expect, it } from 'vitest';
import {
  AgentConfig,
  AgentGuardrailPolicy,
  MULAW_8K,
  type InferenceStreamEvent,
  type SessionInput,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { BoundedSpeechScheduler } from '../../plugin-voice/src/scheduler.ts';
import { NativeStreamingSpeechOutput } from '../../plugin-voice/src/speech/media-output-v2.ts';
import { streamAgentReply } from '../src/agent-stream.ts';
import { GuardrailMetrics, ReplyGuardrail } from '../src/guardrail.ts';

const config = AgentConfig.parse({
  name: 'Collections',
  mode: 'agent',
  context: 'You collect overdue EMIs for Acme Finance. Never offer a waiver or discount.',
  variables: {
    type: 'object',
    properties: {
      outstanding: { type: 'number', 'x-ovo-currency': 'INR', 'x-ovo-format': 'currency' },
    },
  },
  uncertainty: 'Let me check that and get back to you.',
});
const session: SessionInput = {
  mode: 'agent',
  language: 'en-IN',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};

async function* deltas(parts: readonly string[]): AsyncGenerator<InferenceStreamEvent> {
  for (const delta of parts) yield { kind: 'text-delta', delta };
  yield { kind: 'finish' };
}

// LAT-5 with the Wave 3 guardrail: the guard runs on each sentence before the scheduler sees it,
// so a blocked sentence never reaches the reply's provider context, while the checked sentences
// around it still share that one context.
it('a guardrail-blocked sentence never reaches the TTS reply context', async () => {
  const pushed: string[] = [];
  let opened = 0;
  const tts: TextToSpeech = {
    capabilities: {
      outputFormats: [MULAW_8K],
      languages: ['*'],
      interim: false,
      wordTimestamps: false,
      turnSignals: [],
      forceEndpoint: false,
      incrementalText: true,
    },
    cacheIdentity: () => ({ provider: 'fake', model: 'm', voice: 'v', revision: '1' }),
    synthesize: () => {
      throw new Error('a reply never synthesizes a single sentence');
    },
    async openReply() {
      opened += 1;
      return {
        segment(text) {
          pushed.push(text);
          return (async function* () {
            yield new Uint8Array(80).fill(0x7f);
          })();
        },
        close: async () => undefined,
      };
    },
  };
  const carrier = createFakeCarrier();
  const output = new NativeStreamingSpeechOutput(tts, carrier.duplex, session, () => undefined);
  const speech = new BoundedSpeechScheduler(output);
  speech.configurePipeline(2);
  const guard = new ReplyGuardrail(
    {
      policy: AgentGuardrailPolicy.parse({ mode: 'block' }),
      fallback: config.uncertainty,
      record: () => undefined,
      metrics: new GuardrailMetrics(),
    },
    ['- outstanding: ₹4,850.00'],
    { outstanding: 4850 },
    1,
  );
  const receipts = [];
  // What the turn driver does with the behaviour's stream: one speak() per yielded segment.
  for await (const text of streamAgentReply(
    deltas(['Your dues are ₹4,850. I can', ' waive ₹500 of it. ', 'Shall I send a link?']),
    'en-IN',
    () => undefined,
    (text) => text,
    undefined,
    (segment) => guard.check(segment),
  ))
    receipts.push(speech.speak(text));
  await expect(Promise.all(receipts)).resolves.toMatchObject([
    { state: 'completed' },
    { state: 'completed' },
  ]);
  expect(pushed).toEqual(['Your dues are ₹4,850.', config.uncertainty]);
  expect(pushed.join(' ')).not.toMatch(/waive|500/);
  expect(opened).toBe(1);
  output.dispose();
  await speech.dispose();
});
