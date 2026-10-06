import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeAssemblyAi, startFakeOpenAi } from './support/fake-providers.ts';
import { FakePlivoCall } from './support/fake-plivo-caller.ts';
import { configureInboundAgent, operatorApi } from './support/operator-setup.ts';
import {
  configurePlivoAgent,
  plivoApplicationUrls,
  type PlivoAgent,
} from './support/plivo-setup.ts';
import { startLiveStack, type LiveStack } from './support/stack.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl)
  throw new Error(
    'The Plivo DID test needs OVO_TEST_POSTGRES_URL (a database it may create schemas in)',
  );

const CALLER = 'Namaste, mujhe apne loan ke baare mein baat karni hai';
const REPLY = 'Namaste, thanks for calling. How can I help you with your loan today?';

/**
 * docs/runbooks/indian-did.md end to end on loopback: an Indian DID on the existing Plivo carrier
 * plugin, bound in the console, answered through the gateway's binding-scoped answer URL, streamed
 * as 8 kHz mu-law, and settled by Plivo's hangup callback. No Plivo host is contacted: there is no
 * route for api.plivo.com, so any REST call would fail the call.
 */
describe('Indian DID on Plivo: answer URL -> stream -> worker -> hangup callback', () => {
  let stack: LiveStack;
  let agent: PlivoAgent;
  let openAi: Awaited<ReturnType<typeof startFakeOpenAi>>;
  let assemblyAi: Awaited<ReturnType<typeof startFakeAssemblyAi>>;

  beforeAll(async () => {
    openAi = await startFakeOpenAi(REPLY);
    assemblyAi = await startFakeAssemblyAi({
      beginDelayMs: 300,
      speechBytes: 8_000,
      transcript: CALLER,
    });
    net.routes.set('api.openai.com', openAi.server.origin);
    net.routes.set('streaming.assemblyai.com', assemblyAi.server.origin);
    stack = await startLiveStack(postgresUrl);
    agent = await configurePlivoAgent(stack.operator, await configureInboundAgent(stack.operator));
    await vi.waitFor(
      () => {
        if (stack.worker.status.state === 'failed') throw new Error(stack.worker.status.detail);
        expect(stack.worker.status.state).toBe('ready');
      },
      { timeout: 30_000, interval: 100 },
    );
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
    await Promise.all([openAi, assemblyAi].map((fake) => fake?.server.close()));
  });

  it('publishes the Plivo application URLs and is live-ready', async () => {
    const urls = await plivoApplicationUrls(stack.operator, agent.bindingId);
    expect(new URL(urls.answer).pathname).toBe(`/carriers/plivo/${agent.bindingId}/inbound`);
    expect(new URL(urls.hangup).pathname).toBe(`/carriers/plivo/${agent.bindingId}/status`);
    const api = operatorApi(stack.operator);
    await vi.waitFor(
      async () => {
        const readiness = await api<{ liveReady: boolean; liveBlockers: unknown }>(
          'GET',
          `/v1/agents/${agent.agentId}/readiness`,
        );
        expect(readiness.liveBlockers).toEqual([]);
        expect(readiness.liveReady).toBe(true);
      },
      { timeout: 15_000, interval: 250 },
    );
  });

  it('answers the DID, speaks the reply as mu-law, and settles the hangup callback', async () => {
    const urls = await plivoApplicationUrls(stack.operator, agent.bindingId);
    const call = new FakePlivoCall(stack.gateway, agent, {
      from: '+919812345678',
      to: agent.number,
    });
    try {
      const answer = await call.ring(urls.answer);
      expect(answer.status).toBe(200);
      expect(answer.xml).toMatch(/<Stream [^>]*contentType="audio\/x-mulaw;rate=8000"/);
      expect(answer.xml).toMatch(/>wss:\/\/voice\.invalid\/carriers\/plivo\//);
      const { streamStatus } = await call.connect(answer.xml);
      expect(streamStatus).toBe(204);

      const route = async () =>
        (
          await stack.db.query<{
            session_id: string;
            job_id: string;
            to_number: string;
            status: string;
            terminal_at: Date | null;
            terminal_reason: string | null;
            released_at: Date | null;
          }>('SELECT * FROM ovo_session_routes WHERE carrier_call_id = $1', [call.callUuid])
        ).rows[0];
      await vi.waitFor(async () => expect((await route())?.session_id).toBeTypeOf('string'), {
        timeout: 10_000,
      });

      await vi.waitFor(() => expect(assemblyAi.transcribed()).toBe(true), {
        timeout: 15_000,
        interval: 100,
      });
      call.fallSilent();
      // Plivo's mu-law reaches the STT without a transcode.
      expect(assemblyAi.sessions.at(-1)?.url).toContain('encoding=pcm_mulaw');
      await vi.waitFor(
        () => {
          expect(openAi.speech.join(' ')).toContain('How can I help you with your loan today?');
          expect(call.received.some((message) => message.event === 'checkpoint')).toBe(true);
          expect(call.agentAudioBytes).toBeGreaterThan(1_000);
        },
        { timeout: 20_000, interval: 100 },
      );
      expect(call.connected, 'the agent hung up on the caller').toBe(true);

      expect(await call.hangUp(urls.hangup)).toBe(204);
      await vi.waitFor(
        async () => {
          const settled = await route();
          expect(settled?.terminal_at).toBeInstanceOf(Date);
          expect(settled?.status).toBe('completed');
          expect(settled?.terminal_reason ?? '').not.toMatch(/^error:/);
        },
        { timeout: 15_000 },
      );
      const { job_id: jobId } = (await route())!;
      const { rows } = await stack.db.query<{ call_id: string | null }>(
        "SELECT payload->>'callId' AS call_id FROM ovo_jobs WHERE id = $1",
        [jobId],
      );
      const api = operatorApi(stack.operator);
      await vi.waitFor(
        async () => {
          const record = await api<{ status: string }>(
            'GET',
            `/v1/calls/${rows[0]?.call_id ?? jobId}`,
          );
          expect(record.status).toBe('completed');
          expect((await route())?.released_at).toBeInstanceOf(Date);
        },
        { timeout: 15_000, interval: 250 },
      );
    } finally {
      call.close();
    }
  }, 90_000);
});
