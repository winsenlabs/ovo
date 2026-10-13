import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeAssemblyAi, startFakeOpenAi } from './support/fake-providers.ts';
import { configureInboundAgent, operatorApi } from './support/operator-setup.ts';
import { RtpCaller, runSippCall } from './support/sip-caller.ts';
import {
  configureSipAgent,
  SIP_GATEWAY_MAIN,
  sipComposeVariables,
  startSipGatewayProcess,
  type SipAgent,
  type SipGatewayProcess,
} from './support/sip-setup.ts';
import { freePort, startLiveStack, type LiveStack } from './support/stack.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});

const ROOT = new URL('../..', import.meta.url).pathname;
const sipp = process.env.OVO_TEST_SIPP;
const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
// `pnpm test:live-path` runs every e2e file; this one needs SIPp too (`pnpm test:sip`).
if (sipp && !postgresUrl)
  throw new Error('The SIP path test needs OVO_TEST_POSTGRES_URL as well as OVO_TEST_SIPP');
if (sipp && !existsSync(join(ROOT, SIP_GATEWAY_MAIN)))
  throw new Error(`OVO_TEST_SIPP is set but ${SIP_GATEWAY_MAIN} does not exist`);

const CALLER = 'Namaste, mujhe apne loan ke baare mein baat karni hai';
const REPLY = 'Namaste, thanks for calling. How can I help you with your loan today?';
/** Long enough for STT, the reply and its playout; the agent must not hang up in that time. */
const HOLD_MS = 15_000;
/** Every object (at any depth) of a JSON response that carries a string `type` or `phase`. */
function collect(value: unknown, into: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const item of value) collect(item, into);
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.type === 'string' || typeof record.phase === 'string') into.push(record);
    for (const item of Object.values(record)) collect(item, into);
  }
  return into;
}
/** Our own RTP range, away from the sip lane's SIPp suites (41000-41099) and the defaults. */
const RTP_PORTS = { min: 41300, max: 41399 };

/**
 * Wave 11 end to end on loopback (docs/architecture/sip-gateway.md): SIPp places a call to an
 * Indian DID on a SIP trunk, the native sip-gateway admits it through the real media gateway
 * (ovo-sip/1 signed, Postgres-backed inbound route), bridges RTP to the gateway's media socket as
 * 8 kHz mu-law, the worker answers with fixture STT/LLM/TTS, the reply plays out over RTP with
 * its marks, and the caller's BYE settles the call. Nothing leaves 127.0.0.1.
 */
describe.skipIf(!sipp)('SIP path: SIPp -> sip-gateway -> media gateway -> worker', () => {
  let stack: LiveStack;
  let agent: SipAgent;
  let sipGateway: SipGatewayProcess;
  let dir: string;
  let openAi: Awaited<ReturnType<typeof startFakeOpenAi>>;
  let assemblyAi: Awaited<ReturnType<typeof startFakeAssemblyAi>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ovo-sip-path-'));
    openAi = await startFakeOpenAi(REPLY);
    assemblyAi = await startFakeAssemblyAi({
      beginDelayMs: 300,
      speechBytes: 8_000,
      transcript: CALLER,
    });
    net.routes.set('api.openai.com', openAi.server.origin);
    net.routes.set('streaming.assemblyai.com', assemblyAi.server.origin);
    const controlPort = await freePort();
    const sipVariables = sipComposeVariables(`http://127.0.0.1:${controlPort}`);
    stack = await startLiveStack(postgresUrl!, sipVariables);
    agent = await configureSipAgent(stack.operator, await configureInboundAgent(stack.operator));
    await vi.waitFor(
      () => {
        if (stack.worker.status.state === 'failed') throw new Error(stack.worker.status.detail);
        expect(stack.worker.status.state).toBe('ready');
      },
      { timeout: 30_000, interval: 100 },
    );
    sipGateway = await startSipGatewayProcess({
      root: ROOT,
      dir,
      variables: stack.variables,
      gatewayOrigin: stack.gateway.origin,
      controlPort,
      agent,
      rtpPorts: RTP_PORTS,
    });
  }, 90_000);

  afterAll(async () => {
    await sipGateway?.close();
    await stack?.close();
    await Promise.all([openAi, assemblyAi].map((fake) => fake?.server.close()));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('publishes the admission URL for the trunk file and is live-ready', async () => {
    const api = operatorApi(stack.operator);
    const { items } = await api<{ items: { purpose: string; url: string }[] }>(
      'GET',
      `/v1/provider-bindings/${agent.bindingId}/carrier-urls`,
    );
    const inbound = items.find((item) => item.purpose === 'inbound')?.url;
    expect(new URL(inbound!).pathname).toBe(`/carriers/sip/${agent.bindingId}/inbound`);
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

  it('answers the INVITE, speaks the reply over RTP, and settles on the caller BYE', async () => {
    const caller = new RtpCaller();
    try {
      const call = await runSippCall({
        sipp: sipp!,
        dir,
        target: `127.0.0.1:${sipGateway.sipPort}`,
        service: agent.number,
        localPort: await freePort(),
        rtpPort: await caller.bind(),
        holdMs: HOLD_MS,
      });
      const answer = await call.answered();
      expect(answer.rtpPort).toBeGreaterThanOrEqual(RTP_PORTS.min);
      expect(answer.rtpPort).toBeLessThanOrEqual(RTP_PORTS.max);
      caller.speakTo(answer.rtpPort);

      // Admission: the gateway's inbound route created the session route for this SIP Call-ID.
      const route = async () =>
        (
          await stack.db.query<{
            session_id: string;
            job_id: string;
            carrier_id: string;
            binding_id: string | null;
            status: string;
            terminal_at: Date | null;
            terminal_reason: string | null;
            released_at: Date | null;
          }>('SELECT * FROM ovo_session_routes WHERE carrier_call_id = $1', [answer.callId])
        ).rows[0];
      await vi.waitFor(async () => expect((await route())?.session_id).toBeTypeOf('string'), {
        timeout: 10_000,
      });
      expect(await route()).toMatchObject({ carrier_id: 'sip', binding_id: agent.bindingId });

      // session.open was MULAW_8K: the STT receives the caller's mu-law without a transcode.
      await vi.waitFor(() => expect(assemblyAi.transcribed()).toBe(true), {
        timeout: 15_000,
        interval: 100,
      });
      caller.fallSilent();
      expect(assemblyAi.sessions.at(-1)?.url).toContain('encoding=pcm_mulaw');
      expect(assemblyAi.sessions.at(-1)?.url).toContain('sample_rate=8000');

      // The reply plays out as PCMU RTP towards the caller.
      await vi.waitFor(
        () => {
          expect(openAi.speech.join(' ')).toContain('How can I help you with your loan today?');
          expect(caller.agentAudioBytes).toBeGreaterThan(1_000);
        },
        { timeout: 20_000, interval: 100 },
      );
      expect([...caller.payloadTypes]).toEqual([0]);

      // SIPp exits 0 only if nothing interrupted the hold (an agent BYE would) and our BYE got 200.
      const sippExit = await call.exit;
      expect(sippExit.code, sippExit.output).toBe(0);

      await vi.waitFor(
        async () => {
          const settled = await route();
          expect(settled?.terminal_at).toBeInstanceOf(Date);
          expect(settled?.status).toBe('completed');
          // The caller's BYE reached the gateway as the carrier's stop, not as an agent hangup.
          expect(settled?.terminal_reason).toBe('caller_hangup');
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

      // Played marks: the sip-gateway's pacer returned every reply mark, so each reply segment is
      // `played` on carrier evidence (`confirmed`, playbackEvidence carrier-played), none cut off.
      const evidence = collect(await api('GET', `/v1/calls/${rows[0]?.call_id ?? jobId}/evidence`));
      const played = evidence.filter((entry) => entry.type === 'transcript.agent.played');
      expect(played.map((entry) => entry.text).join(' ')).toContain(REPLY);
      expect(evidence.filter((entry) => entry.type === 'transcript.agent.interrupted')).toEqual([]);
      const acknowledged = evidence.filter(
        (entry) => entry.kind === 'response' && entry.phase === 'acknowledged',
      );
      expect(acknowledged.length).toBeGreaterThanOrEqual(2);
      expect(new Set(acknowledged.map((entry) => entry.evidence))).toEqual(new Set(['confirmed']));
    } finally {
      caller.close();
    }
  }, 120_000);
});
