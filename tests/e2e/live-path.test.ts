import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  startFakeAssemblyAi,
  startFakeOpenAi,
  startFakeTwilioRest,
} from './support/fake-providers.ts';
import { FakeTwilioCall } from './support/fake-twilio-caller.ts';
import {
  carrierUrls,
  configureInboundAgent,
  operatorApi,
  type InboundAgent,
} from './support/operator-setup.ts';
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
    'The live-path test needs OVO_TEST_POSTGRES_URL (a database it may create schemas in)',
  );

// Slower than the 3s pre-session buffer that dropped live call 2 (8d76756), inside the 5s
// ingress-queue bound that STT-1 tracks.
const STT_HANDSHAKE_MS = 4_000;
const CALLER = 'Hello, is anyone there?';
const REPLY = 'Hello, thanks for calling the live path line. How can I help you today?';

describe('live inbound call path: fake Twilio -> gateway -> worker -> fake providers', () => {
  let stack: LiveStack;
  let agent: InboundAgent;
  let openAi: Awaited<ReturnType<typeof startFakeOpenAi>>;
  let assemblyAi: Awaited<ReturnType<typeof startFakeAssemblyAi>>;
  let twilioRest: Awaited<ReturnType<typeof startFakeTwilioRest>>;
  let terminalReason: string | null | undefined;

  beforeAll(async () => {
    openAi = await startFakeOpenAi(REPLY);
    assemblyAi = await startFakeAssemblyAi({
      beginDelayMs: STT_HANDSHAKE_MS,
      speechBytes: 8_000,
      transcript: CALLER,
    });
    twilioRest = await startFakeTwilioRest();
    net.routes.set('api.openai.com', openAi.server.origin);
    net.routes.set('streaming.assemblyai.com', assemblyAi.server.origin);
    net.routes.set('api.twilio.com', twilioRest.server.origin);
    stack = await startLiveStack(postgresUrl);
    agent = await configureInboundAgent(stack.app);
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
    await Promise.all([openAi, assemblyAi, twilioRest].map((fake) => fake?.server.close()));
  });

  it('is live-ready with protected inbound capacity before the call', async () => {
    const api = operatorApi(stack.app);
    await vi.waitFor(
      async () => {
        const capacity = await api<{ readyProtected: number }>(
          'GET',
          '/v1/operations/inbound/capacity',
        );
        expect(capacity.readyProtected).toBeGreaterThanOrEqual(1);
      },
      { timeout: 15_000, interval: 250 },
    );
    const readiness = await api<{ liveReady: boolean; liveBlockers: unknown }>(
      'GET',
      `/v1/agents/${agent.agentId}/readiness`,
    );
    expect(readiness.liveBlockers).toEqual([]);
    expect(readiness.liveReady).toBe(true);
  });

  it('answers a signed Twilio call, speaks the reply, and settles the caller hang-up', async () => {
    const urls = await carrierUrls(stack.app, agent.twilioBindingId);
    const call = new FakeTwilioCall(stack.gateway, agent, {
      from: '+919800000001',
      to: agent.number,
    });
    try {
      const answer = await call.ring(urls.voice);
      expect(answer.status).toBe(200);
      expect(answer.twiml).toMatch(
        /<Connect><Stream url="wss:\/\/voice\.invalid\/carriers\/twilio\//,
      );
      expect(answer.twiml).toContain('<Parameter name="sid"');
      expect(answer.twiml).toContain('<Parameter name="rt"');
      await call.connect(answer.twiml);

      // The gateway authenticates the route and the worker claims it (worker_slot_epoch, ffe915c).
      const route = async () =>
        (
          await stack.db.query<{
            session_id: string;
            job_id: string;
            status: string;
            handshake_claimed_at: Date | null;
            terminal_at: Date | null;
            terminal_reason: string | null;
            released_at: Date | null;
          }>('SELECT * FROM ovo_session_routes WHERE carrier_call_id = $1', [call.callSid])
        ).rows[0];
      await vi.waitFor(
        async () => expect((await route())?.handshake_claimed_at).toBeInstanceOf(Date),
        { timeout: 10_000 },
      );
      const { session_id: sessionId, job_id: jobId } = (await route())!;
      await vi.waitFor(
        async () => {
          const opened = await stack.db.query(
            "SELECT 1 FROM ovo_carrier_callbacks WHERE session_id = $1 AND status = 'session_opened'",
            [sessionId],
          );
          expect(opened.rowCount).toBe(1);
        },
        { timeout: 15_000 },
      );

      // The caller's audio, buffered through a slow STT handshake (8d76756), reaches the STT.
      await vi.waitFor(
        () => {
          expect(call.connected, 'the call was dropped before the caller was heard').toBe(true);
          expect(assemblyAi.transcribed()).toBe(true);
        },
        { timeout: 15_000, interval: 100 },
      );
      call.fallSilent();
      expect(assemblyAi.sessions[0]?.url).toContain('encoding=pcm_mulaw');

      // The reply is synthesised past the SSE [DONE] sentinel (c201818) and played to the caller.
      await vi.waitFor(
        () => {
          expect(openAi.speech.join(' ')).toContain('How can I help you today?');
          expect(call.received.some((message) => message.event === 'mark')).toBe(true);
        },
        { timeout: 20_000, interval: 100 },
      );
      expect(call.agentAudioBytes).toBeGreaterThan(1_000);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(call.connected, 'the agent hung up on the caller').toBe(true);
      expect(twilioRest.requests).toEqual([]);
      expect((await route())?.terminal_at).toBeNull();

      // Caller hangs up: stop on the stream, then Twilio's completed status callback.
      expect(await call.hangUp(urls.status)).toBe(204);
      await vi.waitFor(
        async () => {
          const settled = await route();
          expect(settled?.terminal_at).toBeInstanceOf(Date);
          expect(settled?.status).toBe('completed');
        },
        { timeout: 15_000 },
      );
      await vi.waitFor(
        async () => {
          const job = await stack.db.query<{ status: string }>(
            'SELECT status FROM ovo_jobs WHERE id = $1',
            [jobId],
          );
          expect(job.rows[0]?.status).toBe('completed');
        },
        { timeout: 15_000 },
      );
      // The dispatcher finishes the call record and releases the route; the worker is
      // protected inbound capacity again.
      const api = operatorApi(stack.app);
      const { rows } = await stack.db.query<{ call_id: string | null }>(
        "SELECT payload->>'callId' AS call_id FROM ovo_jobs WHERE id = $1",
        [jobId],
      );
      await vi.waitFor(
        async () => {
          const record = await api<{ status: string }>(
            'GET',
            `/v1/calls/${rows[0]?.call_id ?? jobId}`,
          );
          expect(record.status).toBe('completed');
          expect((await route())?.released_at).toBeInstanceOf(Date);
          const capacity = await api<{ readyProtected: number }>(
            'GET',
            '/v1/operations/inbound/capacity',
          );
          expect(capacity.readyProtected).toBeGreaterThanOrEqual(1);
        },
        { timeout: 15_000, interval: 250 },
      );
      terminalReason = (await route())?.terminal_reason;
    } finally {
      call.close();
    }
  }, 90_000);

  // TODO(OBS-1): a Twilio `stop` closes the session as `carrier stream-ended`, which maps to
  // `error:carrier stream-ended`, so every normal caller hang-up is recorded as a failure. Flip
  // this to `it` when OBS-1 lands.
  it.fails('records the caller hang-up as a normal end, not an error (OBS-1)', () => {
    expect(terminalReason).toBeDefined();
    expect(terminalReason).not.toMatch(/^error:/);
  });
});
