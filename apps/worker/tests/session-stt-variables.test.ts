import { describe, expect, it } from 'vitest';
import {
  Cap,
  MULAW_8K,
  type SpeechToText,
  type SttSession,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { sessionSttPlugin, SttPreconnect } from '../src/session-stt-preconnect.ts';

// STT-11: the call's variables reach the STT plugin's start, where it takes per-call keyterms.

const capabilities = {
  inputFormats: [MULAW_8K],
  languages: ['*'],
  interim: true,
  wordTimestamps: false,
  turnSignals: ['end-of-turn'],
  forceEndpoint: false,
} as const;

function recordingStt() {
  const inputs: Parameters<SpeechToText['start']>[0][] = [];
  const stt: SpeechToText = {
    capabilities,
    async start(input) {
      inputs.push(input);
      const session: SttSession = {
        async write() {},
        async finish() {},
        async cancel() {},
      };
      return session;
    },
  };
  return { stt, inputs };
}

function pluginFor(stt: SpeechToText) {
  return definePlugin(
    {
      id: '@fixture/keyterm-stt',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'stt',
      provider: 'fixture',
      provides: [`${Cap.stt}@2`],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities,
      meters: [{ key: 'fixture.stt.audio', unit: 'audio_seconds', label: 'Audio', role: 'stt' }],
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['stt@1'],
    },
    (ctx) => {
      ctx.provide(Cap.stt, stt);
    },
  );
}

const start = (usage: UsageMeter[] = []) => ({
  sessionId: 'call-1',
  format: MULAW_8K,
  language: 'en-IN',
  signal: new AbortController().signal,
  onEvent: () => undefined,
  onUsage: (meter: UsageMeter) => usage.push(meter),
});

describe("the session's STT start carries the call variables (STT-11)", () => {
  it('passes them on every start, a reconnect included', async () => {
    const { stt, inputs } = recordingStt();
    const variables = { full_name: 'Ravi Kumar' };
    const definition = sessionSttPlugin(pluginFor(stt), variables);
    const composition = await compose([{ id: definition.manifest.id }], [definition], {
      scope: 'session',
    });
    const session = composition.get(Cap.stt) as SpeechToText;
    await session.start(start());
    await session.start(start());
    expect(inputs.map((input) => input.variables)).toEqual([variables, variables]);
    await composition.dispose();
  });

  it('opens the preconnected session with them too, and the engine adopts it', async () => {
    const early = recordingStt();
    const variables = { full_name: 'Ravi Kumar' };
    const preconnect = new SttPreconnect(
      async () => ({ stt: early.stt, close: async () => undefined }),
      { sessionId: 'call-1', format: MULAW_8K, language: 'en-IN', variables },
      () => undefined,
    );
    const late = recordingStt();
    const definition = sessionSttPlugin(pluginFor(late.stt), variables, preconnect);
    const composition = await compose([{ id: definition.manifest.id }], [definition], {
      scope: 'session',
    });
    await (composition.get(Cap.stt) as SpeechToText).start(start());
    expect(early.inputs.map((input) => input.variables)).toEqual([variables]);
    expect(late.inputs).toEqual([]);
    await preconnect.dispose();
    await composition.dispose();
  });
});
