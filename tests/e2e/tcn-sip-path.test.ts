import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InboundAdmission } from '../../packages/contracts/src/index.ts';
import { startFakeAssemblyAi, startFakeOpenAi } from './support/fake-providers.ts';
import { configureInboundAgent, operatorApi } from './support/operator-setup.ts';
import { RtpCaller, runSippCall } from './support/sip-caller.ts';
import {
  configureSipAgent,
  SIP_GATEWAY_MAIN,
  sipComposeVariables,
  startSipGatewayProcess,
  TCN,
  type SipAgent,
  type SipGatewayProcess,
} from './support/sip-setup.ts';
import { freePort, startLiveStack, type LiveStack } from './support/stack.ts';

const net = vi.hoisted(() => ({
  routes: new Map<string, string>(),
  /** Every InboundAdmission the media gateway's admission port received, as the plugin built it. */
  admissions: [] as InboundAdmission[],
}));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});
// Records what reaches the gateway's admission port: the carrier plugin's output, after the
// TCN plugin added its tcn.* keys and before operations decides on the call.
vi.mock('../../apps/media-gateway/src/inbound-admission.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../apps/media-gateway/src/inbound-admission.ts')>();
  return {
    ...actual,
    createInboundAdmission: (options: Parameters<typeof actual.createInboundAdmission>[0]) => {
      const ports = actual.createInboundAdmission(options);
      return {
        ...ports,
        admitInbound: (admission: InboundAdmission) => {
          net.admissions.push(admission);
          return ports.admitInbound(admission);
        },
      };
    },
  };
});

const ROOT = new URL('../..', import.meta.url).pathname;
const sipp = process.env.OVO_TEST_SIPP;
const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
// Gated exactly like tests/e2e/sip-path.test.ts (`pnpm test:sip`).
if (sipp && !postgresUrl)
  throw new Error('The TCN SIP path test needs OVO_TEST_POSTGRES_URL as well as OVO_TEST_SIPP');
if (sipp && !existsSync(join(ROOT, SIP_GATEWAY_MAIN)))
  throw new Error(`OVO_TEST_SIPP is set but ${SIP_GATEWAY_MAIN} does not exist`);

const CALLER = 'Hello, I am calling about my account balance';
const REPLY = 'Hello, thanks for calling. How can I help you with your account today?';
const HOLD_MS = 12_000;
/** Allow-listed on both the trunk entry and the TCN binding: must surface as a tcn.* key. */
const CALL_SID = 'X-TCN-Call-Sid';
const CALL_SID_VALUE = 'tcn-e2e-7c1f';
/** Sent by "TCN" but on neither list: must be dropped by the sip-gateway. */
const UNLISTED = 'X-TCN-Internal';
/** Away from sip-path.test.ts (41300-41399) and the sip lane's SIPp suites (41000-41099). */
const RTP_PORTS = { min: 41400, max: 41499 };

/**
 * TCN over SIP end to end on loopback (docs/runbooks/tcn-sip.md): SIPp plays TCN delivering a call
 * to an Indian DID through a `carrierId: 'tcn'` trunk entry. The sip-gateway admits it through
 * `/carriers/tcn/<binding>/inbound` (the TCN plugin's ingress and the gateway's sip verifier),
 * the allow-listed X- header reaches the admission as `tcn.x-tcn-call-sid`, the worker answers
 * with fixture STT/LLM/TTS over RTP, and the caller's BYE settles the call under carrier `tcn`.
 */
describe.skipIf(!sipp)(
  'TCN SIP path: SIPp (as TCN) -> sip-gateway -> media gateway -> worker',
  () => {
    let stack: LiveStack;
    let agent: SipAgent;
    let sipGateway: SipGatewayProcess;
    let dir: string;
    let openAi: Awaited<ReturnType<typeof startFakeOpenAi>>;
    let assemblyAi: Awaited<ReturnType<typeof startFakeAssemblyAi>>;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'ovo-tcn-path-'));
      openAi = await startFakeOpenAi(REPLY);
      assemblyAi = await startFakeAssemblyAi({
        beginDelayMs: 300,
        speechBytes: 8_000,
        transcript: CALLER,
      });
      net.routes.set('api.openai.com', openAi.server.origin);
      net.routes.set('streaming.assemblyai.com', assemblyAi.server.origin);
      const controlPort = await freePort();
      stack = await startLiveStack(
        postgresUrl!,
        sipComposeVariables(`http://127.0.0.1:${controlPort}`),
      );
      agent = await configureSipAgent(stack.operator, await configureInboundAgent(stack.operator), {
        carrierId: 'tcn',
        number: '+918000000002',
        trunkId: 'tcn-loop',
        forwardHeaders: [CALL_SID],
      });
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

    it('publishes the TCN admission URL and is live-ready', async () => {
      const api = operatorApi(stack.operator);
      const { items } = await api<{ items: { purpose: string; url: string }[] }>(
        'GET',
        `/v1/provider-bindings/${agent.bindingId}/carrier-urls`,
      );
      const inbound = items.find((item) => item.purpose === 'inbound')?.url;
      expect(new URL(inbound!).pathname).toBe(`/carriers/tcn/${agent.bindingId}/inbound`);
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

    it('admits TCN with its tcn.* metadata, speaks over RTP and settles on the BYE', async () => {
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
          headers: { [CALL_SID]: CALL_SID_VALUE, [UNLISTED]: 'must-not-forward' },
        });
        const answer = await call.answered();
        expect(answer.rtpPort).toBeGreaterThanOrEqual(RTP_PORTS.min);
        expect(answer.rtpPort).toBeLessThanOrEqual(RTP_PORTS.max);
        caller.speakTo(answer.rtpPort);

        // The admission the TCN plugin handed the gateway carries the allow-listed header twice:
        // under its SIP name and as the binding's tcn.* key. The unlisted header is gone.
        const admission = net.admissions.find((entry) => entry.carrierCallId === answer.callId);
        expect(admission).toMatchObject({
          carrierId: 'tcn',
          bindingId: agent.bindingId,
          to: agent.number,
          from: '+919812345678',
        });
        expect(admission!.raw).toMatchObject({
          [`sip.header.${CALL_SID}`]: CALL_SID_VALUE,
          'tcn.x-tcn-call-sid': CALL_SID_VALUE,
          'sip.trunkId': agent.trunkId,
        });
        expect(Object.keys(admission!.raw ?? {}).filter((key) => /internal/i.test(key))).toEqual(
          [],
        );

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
        expect(await route()).toMatchObject({ carrier_id: 'tcn', binding_id: agent.bindingId });
        const { rows: routed } = await stack.db.query<{ carrier_plugin_id: string }>(
          'SELECT carrier_plugin_id FROM ovo_ops_inbound_routes WHERE phone_number = $1',
          [agent.number],
        );
        expect(routed[0]?.carrier_plugin_id).toBe(TCN);

        await vi.waitFor(() => expect(assemblyAi.transcribed()).toBe(true), {
          timeout: 15_000,
          interval: 100,
        });
        caller.fallSilent();
        expect(assemblyAi.sessions.at(-1)?.url).toContain('encoding=pcm_mulaw');

        await vi.waitFor(
          () => {
            expect(openAi.speech.join(' ')).toContain(
              'How can I help you with your account today?',
            );
            expect(caller.agentAudioBytes).toBeGreaterThan(1_000);
          },
          { timeout: 20_000, interval: 100 },
        );
        expect([...caller.payloadTypes]).toEqual([0]);

        const sippExit = await call.exit;
        expect(sippExit.code, sippExit.output).toBe(0);

        await vi.waitFor(
          async () => {
            const settled = await route();
            expect(settled?.terminal_at).toBeInstanceOf(Date);
            expect(settled?.status).toBe('completed');
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
      } finally {
        caller.close();
      }
    }, 120_000);
  },
);
