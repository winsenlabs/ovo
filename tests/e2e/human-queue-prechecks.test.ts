import { describe, expect, it, vi } from 'vitest';
import { HUMAN_LINES, holdPolicy, humanStack, type HumanStack } from './support/human-setup.ts';
import { at, hungUpByPlatform, of } from './support/human-call.ts';
import { LINES } from './support/routing-setup.ts';
import { heard, transferCall } from './support/transfer-call.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  const { routedLookup } = await import('./support/routed-net.ts');
  return { ...actual, lookup: routedLookup(actual.lookup as never, net.routes) };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl) throw new Error('The human-queue-prechecks test needs OVO_TEST_POSTGRES_URL');

/** One installation for one case: each is closed before the next starts (connections add up). */
async function withStack(
  options: Parameters<typeof humanStack>[2],
  run: (env: HumanStack) => Promise<void>,
) {
  const env = await humanStack(postgresUrl!, net.routes, options);
  try {
    await run(env);
  } finally {
    await env.close();
  }
}

/**
 * A router call that misses the classifier, falls to the desk queue and must move on to the
 * default agent: returns what the call left behind and what the caller was told.
 */
async function missedCall(env: HumanStack) {
  const spoken = env.openAi.speech.length;
  const result = await transferCall(env, async (call) => {
    await heard(env, call, LINES.greeting);
    env.stt.say('I have a strange question');
    await heard(env, call, LINES.fallback);
  });
  return { ...result, said: env.openAi.speech.slice(spoken) };
}

describe('human queue prechecks (R3): the router chain moves on without a word', () => {
  /** The refusal the human step failed with, the default agent taking over, nothing announced. */
  function expectSkipped(
    result: Awaited<ReturnType<typeof missedCall>>,
    env: HumanStack,
    expected: { reason: string; refusal?: string },
  ) {
    const { events } = result;
    const human = at(events, 'route.fallback', { step: 'human' });
    expect(events[human]!.payload).toMatchObject({
      result: expected.reason === 'human_queue_unavailable' ? 'skipped' : 'failed',
      reason: expected.reason,
    });
    const taken = at(events, 'route.fallback', { step: 'default', result: 'taken' });
    expect(human).toBeLessThan(taken);
    if (expected.refusal)
      at(events, 'human.requested', { result: 'refused', refusal: expected.refusal });
    else expect(of(events, 'human.requested')).toEqual([]);
    expect(of(events, 'human.webhook')).toEqual([]);
    expect(result.said.join(' ')).not.toContain(HUMAN_LINES.announcement);
    expect(env.acd.requests).toEqual([]);
  }

  it('4a. a queue closed by its hours is refused before any announcement or webhook', async () => {
    await withStack(
      { line: { external: { hours: { timezone: 'Asia/Kolkata', weekly: {}, closed: [] } } } },
      async (env) =>
        expectSkipped(await missedCall(env), env, {
          reason: 'queue_closed',
          refusal: 'queue_closed',
        }),
    );
  });

  it('4b. five failed deliveries open the breaker: the sixth caller is not held at all', async () => {
    await withStack({ line: { external: { hold: holdPolicy(5) } } }, async (env) => {
      for (let call = 1; call <= 5; call += 1) {
        env.acd.reply({ status: 503 }, { status: 503 }, { status: 503 });
        const failed = await transferCall(
          env,
          async (phone) => {
            await heard(env, phone, LINES.greeting);
            env.stt.say('I have a strange question');
            await hungUpByPlatform(env, phone);
          },
          { carrier: 'hangup' },
        );
        at(failed.events, 'human.state', { state: 'released', code: 'webhook_failed' });
      }
      const sent = env.acd.requests.length;
      expect(sent).toBe(15);
      const result = await missedCall(env);
      expect(env.acd.requests).toHaveLength(sent);
      const { events } = result;
      at(events, 'human.requested', { result: 'refused', refusal: 'queue_unavailable' });
      const human = at(events, 'route.fallback', { step: 'human' });
      expect(events[human]!.payload).toMatchObject({
        result: 'failed',
        reason: 'queue_unavailable',
      });
      at(events, 'route.fallback', { step: 'default', result: 'taken' });
      expect(of(events, 'human.webhook').length).toBe(0);
      // The sixth caller heard the default agent's opening, never the queue's announcement.
      expect(result.said.join(' ')).not.toContain(HUMAN_LINES.announcement);
    });
  });

  it('4c. with the webhook flag off an external queue is unavailable and nothing is sent', async () => {
    await withStack({ webhook: false }, async (env) =>
      expectSkipped(await missedCall(env), env, {
        reason: 'queue_unavailable',
        refusal: 'queue_unavailable',
      }),
    );
  });

  it('4d. flag-off parity: a worker without OVO_HUMAN_QUEUE_ENABLED skips the step exactly as R2 does', async () => {
    await withStack({ workerVariables: { OVO_HUMAN_QUEUE_ENABLED: 'false' } }, async (env) => {
      // The queues exist and are bound in the published release, but the worker does not know them.
      expect(env.line.queues.desk).toBeTruthy();
      expectSkipped(await missedCall(env), env, { reason: 'human_queue_unavailable' });
      expect(env.acd.deliveries()).toEqual([]);
    });
  });
});
