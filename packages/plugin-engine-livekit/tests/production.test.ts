import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { Cap, type VoiceSessionEngine, type Speech } from '@winsendotai/ovo-contracts';
import { compose, definePlugin, setGlibcProbe } from '@winsendotai/ovo-runtime';
import {
  createFakeCarrier,
  createScriptedStt,
  createScriptedTts,
  installEgressSentinel,
  realClock,
  type EgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';
import { loadDistribution } from '../../distribution/src/load.ts';
import { ENGINE_ID } from '../src/plugin.ts';
let sentinel: EgressSentinel;
beforeAll(() => {
  sentinel = installEgressSentinel({ allowLoopback: false });
});
afterAll(() => {
  try {
    expect(sentinel.attempts).toEqual([]);
  } finally {
    sentinel.restore();
    setGlibcProbe(undefined);
  }
});

it('loads through production distribution and composes the lazy engine with its speech companion', async () => {
  // The manifest intentionally requires Linux glibc. This probe permits composition on the Mac
  // developer host; the actual pinned Darwin native binary is still loaded and executed.
  setGlibcProbe(() => 'test-host-native-binding');
  const distribution = await loadDistribution({
    role: 'api',
    profile: 'compose',
    env: {},
    log() {},
  });
  expect(distribution.catalog.some((p) => p.manifest.id === ENGINE_ID)).toBe(true);
  const carrier = createFakeCarrier();
  const stt = createScriptedStt();
  const tts = createScriptedTts();
  const receipts: string[] = [];
  const host = definePlugin(
    {
      id: 'e3-test-host',
      version: '0.1.0',
      contractVersion: 2,
      kind: 'host',
      scope: 'session',
      provides: [Cap.media, Cap.stt, Cap.tts, Cap.behavior, Cap.clock, Cap.usage],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.media, carrier.duplex);
      ctx.provide(Cap.stt, stt);
      ctx.provide(Cap.tts, tts);
      ctx.provide(Cap.clock, realClock);
      ctx.provide(Cap.usage, () => {});
      ctx.provide(Cap.behavior, {
        async respond(text, variables) {
          expect(variables).toEqual({ name: 'Asha' });
          return `Received ${text}.`;
        },
        onPlayback(receipt) {
          receipts.push(receipt.text);
        },
      });
    },
  );
  const graph = await compose(
    [
      { id: host.manifest.id },
      { id: `${ENGINE_ID}/speech` },
      {
        id: ENGINE_ID,
        config: {
          engine: {},
          session: {
            mode: 'faq',
            language: 'en-US',
            inputEnabled: true,
            variables: { name: 'Asha' },
            maxCallSeconds: 60,
            acknowledgements: [],
          },
        },
      },
    ],
    [...distribution.catalog, host],
    { scope: 'session' },
  );
  const engine = graph.get(Cap.engine) as VoiceSessionEngine;
  const speech = graph.get(Cap.speech) as Speech;
  try {
    const progress = speech.speak('Queued before engine start.', { kind: 'progress' });
    await engine.start();
    expect((await progress).state).toBe('completed');
    (await stt.session()).say('hello fixture');
    await vi.waitFor(() => expect(receipts).toContain('Received hello fixture.'), {
      timeout: 10000,
    });
    expect(carrier.log.some((entry) => entry.type === 'audio')).toBe(true);
    const actual = engine as unknown as {
      session: { tools: unknown[]; llm: unknown; on: (event: string, fn: () => void) => void };
    };
    expect(actual.session.tools).toEqual([]);
    expect(actual.session.llm).toBeUndefined();
    expect(graph.violations).toEqual([]);
  } finally {
    await engine.dispose('drain');
    await graph.dispose();
  }
}, 60000);
