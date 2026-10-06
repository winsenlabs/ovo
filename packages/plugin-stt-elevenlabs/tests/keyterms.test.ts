import {
  Cap,
  MULAW_8K,
  type NetFixtureScript,
  type SpeechToText,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { elevenLabsSttPlugin } from '../src/index.ts';
import { scribeKeyterms, SCRIBE_MAX_KEYTERMS } from '../src/keyterms.ts';
import { ElevenLabsStt } from '../src/provider.ts';
import { RETRIEVED, SOURCE, sessionStarted } from '../src/testing.ts';

// STT-11: keyterms were a static binding field, so a customer's name was misheard on every call.

const variables = {
  full_name: 'Venkataraman Subramaniam',
  lender: { name: 'CreditMantri' },
  emi: 4210,
  products: ['Gold loan', 'EMI'],
};

describe('Scribe per-call keyterms (STT-11)', () => {
  it('adds the named call values after the binding and agent terms, within the provider limits', () => {
    expect(
      scribeKeyterms(
        ['EMI'],
        {
          keyterms: ['Bajaj Finserv', 'emi'],
          keytermVariables: ['full_name', 'lender.name', 'emi', 'products', 'missing'],
        },
        variables,
      ),
    ).toEqual([
      'EMI',
      'Bajaj Finserv',
      // 24 characters: favoured word by word.
      'Venkataraman',
      'Subramaniam',
      'CreditMantri',
      '4210',
      'Gold loan',
    ]);
    const many = Array.from({ length: 80 }, (_, index) => `term ${index}`);
    const capped = scribeKeyterms(['fixed'], { keytermVariables: ['many'] }, { many });
    expect(capped).toHaveLength(SCRIBE_MAX_KEYTERMS);
    expect(capped[0]).toBe('fixed');
    expect(scribeKeyterms(undefined, {}, undefined)).toEqual([]);
  });

  it("connects with this call's terms in the keyterms query", async () => {
    const net = createFixtureNet([opening()]);
    const stt = new ElevenLabsStt(net, 'fixture-key', { keyterms: ['EMI'] }, undefined, {
      keytermVariables: ['full_name'],
    });
    const session = await stt.start({
      sessionId: 'scribe-keyterms',
      format: MULAW_8K,
      language: 'en-IN',
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onUsage: () => undefined,
      variables: { full_name: 'Ravi Kumar' },
    });
    const url = new URL(net.log.find((entry) => entry.kind === 'ws-open')!.url!);
    expect(url.searchParams.getAll('keyterms')).toEqual(['EMI', 'Ravi Kumar']);
    await session.cancel('done');
  });

  it("takes the agent's keyterm settings from the plugin config through the real runtime", async () => {
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
            id: elevenLabsSttPlugin.manifest.id,
            config: { binding: {}, credentialRef: { credentialId: 'cred-1' }, ...config },
          },
        ],
        [elevenLabsSttPlugin],
        { scope: 'session', parent, workspaceId: 'workspace-1', net },
      );
    try {
      await expect(row({ keytermVariables: [''] })).rejects.toThrow();
      const net = createFixtureNet([opening()]);
      const composition = await row({ keyterms: ['EMI'], keytermVariables: ['full_name'] }, net);
      const stt = composition.get(Cap.stt) as SpeechToText;
      const session = await stt.start({
        sessionId: 'scribe-keyterms',
        format: MULAW_8K,
        language: 'en-IN',
        signal: new AbortController().signal,
        onEvent: () => undefined,
        onUsage: () => undefined,
        variables: { full_name: 'Ravi Kumar' },
      } as Parameters<SpeechToText['start']>[0]);
      const url = new URL(net.log.find((entry) => entry.kind === 'ws-open')!.url!);
      expect(url.searchParams.getAll('keyterms')).toEqual(['EMI', 'Ravi Kumar']);
      await session.cancel('done');
      await composition.dispose();
    } finally {
      await parent.dispose();
    }
  });
});

function opening(): NetFixtureScript {
  return {
    host: 'api.elevenlabs.io',
    source: SOURCE,
    retrieved: RETRIEVED,
    steps: [
      { expect: 'ws-open', url: /^wss:\/\/api\.elevenlabs\.io\/v1\/speech-to-text\/realtime\?/ },
      { send: sessionStarted() },
    ],
  };
}
