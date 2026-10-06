import {
  Cap,
  MULAW_8K,
  type NetFixtureScript,
  type SpeechToText,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { assemblyAiPlugin } from '../src/index.ts';
import { callKeyterms, MAX_KEYTERMS } from '../src/keyterms.ts';
import { terminationSteps } from '../src/testing.ts';

// STT-11: keyterms were a static binding field, so a customer's name was misheard on every call.

const begin = JSON.stringify({
  type: 'Begin',
  id: 'aa-keyterms',
  expires_at: '2026-10-06T00:00:00Z',
  configuration: { model: 'universal-streaming-english' },
});

function opening(): NetFixtureScript {
  return {
    host: 'streaming.assemblyai.com',
    source: 'https://www.assemblyai.com/docs/streaming/keyterms-prompting',
    retrieved: '2026-10-06',
    steps: [
      { expect: 'ws-open', url: /^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?/ },
      { send: begin },
      ...terminationSteps(),
    ],
  };
}

const start = (variables: Record<string, unknown>) =>
  ({
    sessionId: 'aa-keyterms',
    format: MULAW_8K,
    language: 'en-IN',
    signal: new AbortController().signal,
    onEvent: () => undefined,
    onUsage: () => undefined,
    variables,
  }) as Parameters<SpeechToText['start']>[0];

describe('AssemblyAI per-call keyterms (STT-11)', () => {
  it('adds the named call values after the binding and agent terms, within the provider limits', () => {
    expect(
      callKeyterms(
        ['EMI'],
        {
          keyterms: ['Bajaj Finserv', 'emi'],
          keytermVariables: ['full_name', 'lender.name', 'emi', 'products', 'note', 'missing'],
        },
        {
          full_name: '  Venkataraman   Subramaniam ',
          lender: { name: 'CreditMantri' },
          emi: 4210,
          products: ['Gold loan', 'EMI'],
          note: 'x'.repeat(51),
        },
      ),
    ).toEqual([
      'EMI',
      'Bajaj Finserv',
      'Venkataraman Subramaniam',
      'CreditMantri',
      '4210',
      'Gold loan',
    ]);
    const many = Array.from({ length: 150 }, (_, index) => `term ${index}`);
    const capped = callKeyterms(['fixed'], { keytermVariables: ['many'] }, { many });
    expect(capped).toHaveLength(MAX_KEYTERMS);
    expect(capped[0]).toBe('fixed');
  });

  it("takes the agent's settings from the plugin config and connects with this call's terms", async () => {
    const secrets = definePlugin(
      {
        id: 'fixture-secret-resolver',
        version: '0.1.0',
        contractVersion: 1,
        scope: 'process',
        requires: [],
        provides: [Cap.secrets],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx) => void ctx.provide(Cap.secrets, { resolve: async () => 'fixture-key' }),
    );
    const parent = await compose([{ id: secrets.manifest.id }], [secrets], { scope: 'process' });
    const row = (config: Record<string, unknown>, net = createFixtureNet([])) =>
      compose(
        [
          {
            id: assemblyAiPlugin.manifest.id,
            config: {
              binding: { keyterms: ['EMI'] },
              credentialRef: { credentialId: 'cred-1' },
              ...config,
            },
          },
        ],
        [assemblyAiPlugin],
        { scope: 'session', parent, workspaceId: 'workspace-1', net },
      );
    try {
      await expect(row({ keytermVariables: [''] })).rejects.toThrow();
      const net = createFixtureNet([opening()]);
      const composition = await row({ keytermVariables: ['full_name'] }, net);
      const stt = composition.get(Cap.stt) as SpeechToText;
      const session = await stt.start(start({ full_name: 'Ravi Kumar' }));
      const url = new URL(net.log.find((entry) => entry.kind === 'ws-open')!.url!);
      expect(JSON.parse(url.searchParams.get('keyterms_prompt')!)).toEqual(['EMI', 'Ravi Kumar']);
      await session.cancel('done');
      net.assertComplete();
      await composition.dispose();
    } finally {
      await parent.dispose();
    }
  });

  it('sends no keyterms_prompt when neither the binding nor the call has any', () => {
    expect(callKeyterms(undefined, { keytermVariables: ['full_name'] }, {})).toEqual([]);
  });
});
