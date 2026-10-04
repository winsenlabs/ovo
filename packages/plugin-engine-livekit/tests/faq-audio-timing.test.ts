import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkEngine, startHarness } from '@winsendotai/ovo-conformance';
import { installEgressSentinel, type EgressSentinel } from '@winsendotai/ovo-conformance/drivers';
import { CAPABILITIES } from '../src/plugin.ts';

let sentinel: EgressSentinel;
beforeAll(() => {
  sentinel = installEgressSentinel({ allowLoopback: false });
});
afterAll(() => {
  try {
    expect(sentinel.attempts).toEqual([]);
  } finally {
    sentinel.restore();
  }
});

it('delivers carrier audio after the generated FAQ transcript', async () => {
  const { LiveKitEngine } = await import('../src/session-runner.ts');
  const h = await startHarness(
    {
      factory: async (ports) => {
        const engine = new LiveKitEngine(ports);
        return { engine, speech: engine.speech };
      },
      options: { turnDetector: 'none', timeoutMs: 12000 },
    },
    {
      agent: {
        mode: 'faq',
        faq: [
          {
            id: 'hours',
            question: 'What are your opening hours?',
            answer: 'We are open nine to five.',
          },
        ],
      },
    },
  );
  let audioAtGeneration: boolean | undefined;
  const unsubscribe = h.engine.subscribe((event) => {
    if (
      event.type === 'agent.transcript' &&
      event.state === 'generated' &&
      /nine to five/.test(event.text)
    )
      audioAtGeneration = h.carrier.log.some((item) => item.type === 'audio');
  });
  try {
    await h.say('what are your opening hours');
    await h.until(
      () =>
        h
          .events()
          .some(
            (event) =>
              event.type === 'agent.transcript' &&
              event.state === 'generated' &&
              /nine to five/.test(event.text),
          ),
      'generated FAQ transcript',
    );
    expect(audioAtGeneration).toBe(false);
    await h.until(() => h.carrier.log.some((event) => event.type === 'audio'), 'FAQ carrier audio');
    expect(h.carrier.log.some((event) => event.type === 'audio')).toBe(true);
  } finally {
    unsubscribe();
    await h.close();
  }
}, 30000);

it('the FAQ conformance check rejects an engine whose carrier writer discards every frame', async () => {
  const { LiveKitEngine } = await import('../src/session-runner.ts');
  const failures = await checkEngine(
    async (ports) => {
      const engine = new LiveKitEngine({
        ...ports,
        media: { ...ports.media, async sendAudio() {} },
      });
      return { engine, speech: engine.speech, capabilities: CAPABILITIES };
    },
    { turnDetector: 'none', timeoutMs: 12000 },
    { only: ['FAQ answers without an LLM'] },
  );
  expect(failures.map((failure) => failure.message)).toContain(
    'timed out waiting for FAQ carrier audio',
  );
}, 30000);
