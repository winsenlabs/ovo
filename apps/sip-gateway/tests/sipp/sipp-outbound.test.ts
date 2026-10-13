import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeMediaGateway, PUBLIC_BASE } from '../support/fake-media-gateway.ts';
import {
  CONTROL_TOKEN,
  FROM,
  KEY,
  loopbackTrunk,
  sleep,
  startHarness,
  type Harness,
} from '../support/harness.ts';
import { SIPP, evidence, runSipp, tracedMessages, type SippOptions } from '../support/sipp.ts';
import { digestResponse, parseAuthParams, parseChallenge } from '../../src/sip/digest.ts';

// W11 §17.3 scenarios with SIPp as the trunk (UAS) for outbound calls, plus the SIGTERM drain.
const SIP_PORT = 15160;
const UAS_UDP = 15162;
const UAS_TCP = 15070;
const ENV = {
  OVO_SIP_PORT: String(SIP_PORT),
  OVO_SIP_RTP_PORT_MIN: '41200',
  OVO_SIP_RTP_PORT_MAX: '41299',
};
const TO = '+919812345678';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function gateway(
  outbound: Record<string, unknown> = {},
  trunk: Record<string, unknown> = {},
) {
  harness = await startHarness({
    env: ENV,
    media: evidence(),
    trunks: [
      loopbackTrunk({
        outbound: {
          enabled: true,
          proxy: `sip:127.0.0.1:${UAS_UDP}`,
          fromNumbers: [FROM],
          auth: 'ip',
          ...outbound,
        },
        ...trunk,
      }),
    ],
  });
  return harness;
}

function dial(h: Harness, overrides: Record<string, unknown> = {}) {
  return h.control('POST', '/v1/calls', {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    carrierId: 'sip',
    bindingId: 'binding-1',
    trunkId: 'loop',
    to: TO,
    from: FROM,
    media: {
      url: `${PUBLIC_BASE.replace('https', 'wss')}/carriers/sip/binding-1/media`,
      routeParams: { sid: 's', rt: 'r' },
    },
    callbacks: { status: `${PUBLIC_BASE}/carriers/sip/binding-1/status?r=x` },
    ringTimeoutSec: 30,
    maxDurationSec: 600,
    credentials: null,
    ...overrides,
  });
}

const UAS: SippOptions = { localPort: UAS_UDP, mediaPort: 16100 };

async function expectPass(run: ReturnType<typeof runSipp>) {
  const result = await run.done;
  if (result.code !== 0)
    throw new Error(`sipp exit ${result.code}\n${result.errors}\n${result.output}`);
  return result;
}

/** Starts the SIPp trunk and gives it a moment to bind before the gateway dials it. */
async function trunk(scenario: string, options: Partial<SippOptions> = {}) {
  const run = runSipp(scenario, { ...UAS, ...options });
  await sleep(300);
  return run;
}

describe.skipIf(!SIPP)(
  'SIPp UAS scenarios: outbound through the control API',
  { timeout: 120_000 },
  () => {
    it.each(['MD5', 'SHA-256'])(
      '#13 uas-auth-401 %s: SIPp verifies our Authorization with its own digest code',
      async (algorithm) => {
        const h = await gateway({ auth: 'digest' });
        const run = await trunk('uas-auth-401', {
          keys: { algorithm },
          pauseMs: 2000,
          rtpEcho: true,
        });
        const dialed = await dial(h, {
          credentials: { username: 'trunk-user', password: 'trunk-pass' },
        });
        expect(dialed.body.kind).toBe('accepted');
        await expectPass(run);
        const states = await h.media.waitFor(() =>
          h.media.statuses.some((s) => ['completed', 'failed'].includes(s.state))
            ? h.media.statuses.map((s) => s.state)
            : undefined,
        );
        expect(states).toEqual(['in_progress', 'completed']);
        expect(h.media.framesIn('start')).toHaveLength(1);
      },
    );

    it('#13 uas-auth-407: Proxy-Authorization carries the right digest', async () => {
      const h = await gateway({ auth: 'digest' });
      const run = await trunk('uas-auth-407', { keys: { algorithm: 'MD5' }, pauseMs: 1000 });
      await dial(h, { credentials: { username: 'trunk-user', password: 'trunk-pass' } });
      const result = await expectPass(run);
      const invite = tracedMessages(result.messages, /^INVITE /).find((m) =>
        /Proxy-Authorization:/i.test(m),
      )!;
      const header = /^Proxy-Authorization: (.*)$/im.exec(invite)![1]!;
      const params = parseAuthParams(header)!;
      const challenge = parseChallenge(
        `Digest realm="${params.realm}", nonce="${params.nonce}", qop="auth", algorithm=MD5`,
      )!;
      expect(params.response).toBe(
        digestResponse({
          challenge,
          username: 'trunk-user',
          password: 'trunk-pass',
          method: 'INVITE',
          uri: params.uri!,
          cnonce: params.cnonce!,
          nc: 1,
        }),
      );
      await h.media.waitFor(() => h.media.statuses.find((s) => s.state === 'completed'));
    });

    it('#13 uas-auth-401 over TCP', async () => {
      const h = await gateway(
        { auth: 'digest', proxy: `sip:127.0.0.1:${UAS_TCP};transport=tcp` },
        { transport: 'tcp' },
      );
      const run = await trunk('uas-auth-401', {
        localPort: UAS_TCP,
        transport: 't1',
        keys: { algorithm: 'SHA-256' },
        pauseMs: 1000,
      });
      await dial(h, { credentials: { username: 'trunk-user', password: 'trunk-pass' } });
      await expectPass(run);
      const states = await h.media.waitFor(() =>
        h.media.statuses.some((s) => ['completed', 'failed'].includes(s.state))
          ? h.media.statuses.map((s) => s.state)
          : undefined,
      );
      expect(states).toEqual(['in_progress', 'completed']);
    });

    it.each([
      ['uas-busy', 'busy', false],
      ['uas-503', 'failed', true],
    ] as const)('#14 %s → %s', async (scenario, state, retryable) => {
      const h = await gateway();
      const run = await trunk(scenario);
      await dial(h);
      await expectPass(run);
      const event = await h.media.waitFor(() => h.media.statuses.find((s) => s.state === state));
      expect(event.payload).toMatchObject({ retryable });
    });

    it('#14 uas-noanswer: CANCEL at the ring timeout → no_answer', async () => {
      const h = await gateway();
      const run = await trunk('uas-noanswer');
      const dialed = await dial(h, { ringTimeoutSec: 2 });
      await expectPass(run);
      await h.media.waitFor(() => h.media.statuses.find((s) => s.state === 'no_answer'));
      const reconcile = await h.control(
        'GET',
        `/v1/calls?requestId=${dialed.body.carrierRequestId}`,
      );
      expect(reconcile.body).toMatchObject({ kind: 'ended', state: 'no_answer' });
    });

    it('#19 uas-tcp-5070: a TCP trunk on a non-5060 port, one reused connection, the call completes', async () => {
      const h = await gateway(
        { proxy: `sip:127.0.0.1:${UAS_TCP};transport=tcp` },
        { transport: 'tcp' },
      );
      const run = await trunk('uas-answer', {
        localPort: UAS_TCP,
        transport: 't1',
        pauseMs: 2000,
        rtpEcho: true,
      });
      await dial(h);
      await h.media.waitFor(() => h.media.framesIn('start')[0], 10_000);
      expect(h.running.gateway.endpoint.tcpConnections).toBe(1);
      await expectPass(run);
      await h.media.waitFor(() => h.media.statuses.find((s) => s.state === 'completed'));
      expect(h.running.gateway.endpoint.tcpConnections).toBeLessThanOrEqual(1);
    });

    it('#18 uac-drain: SIGTERM mid-call → new INVITEs get 503, the live call completes, the process exits 0', async () => {
      const media = new FakeMediaGateway({ key: KEY });
      await media.start();
      const dir = mkdtempSync(join(tmpdir(), 'sip-drain-'));
      const trunks = join(dir, 'sip-trunks.json');
      writeFileSync(trunks, JSON.stringify({ version: 1, trunks: [loopbackTrunk()] }));
      const main = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
      const child = spawn(process.execPath, ['--import', 'tsx', main], {
        env: {
          ...process.env,
          ...ENV,
          OVO_SIP_TRANSPORTS: 'udp',
          OVO_SIP_TRUNKS_FILE: trunks,
          OVO_SIP_CONTROL_LISTEN: '127.0.0.1:15190',
          OVO_SIP_HEALTH_LISTEN: '127.0.0.1:15191',
          OVO_SIP_CONTROL_TOKEN: CONTROL_TOKEN,
          OVO_SIP_GATEWAY_SECRET: Buffer.from(KEY).toString('base64'),
          OVO_SIP_MEDIA_INTERNAL_URL: media.url,
          OVO_MEDIA_PUBLIC_BASE_URL: PUBLIC_BASE,
          OVO_SIP_DRAIN_TIMEOUT_MS: '20000',
          OVO_LOG_LEVEL: 'error',
        },
        stdio: 'ignore',
      });
      const exited = new Promise<number | null>((resolve) =>
        child.on('exit', (code) => resolve(code)),
      );
      try {
        for (
          let i = 0;
          i < 50 &&
          !(await fetch('http://127.0.0.1:15191/health').then(
            (r) => r.ok,
            () => false,
          ));
          i += 1
        )
          await sleep(200);
        const remote = `127.0.0.1:${SIP_PORT}`;
        const call = runSipp('uac-basic', {
          localPort: 15161,
          mediaPort: 16110,
          remote,
          pauseMs: 4000,
        });
        await media.waitFor(() => media.framesIn('start')[0], 10_000);
        child.kill('SIGTERM');
        await sleep(300);
        await expectPass(runSipp('uac-draining', { localPort: 15163, mediaPort: 16120, remote }));
        await expectPass(call);
        expect(await exited).toBe(0);
        expect(media.framesIn('stop')[0]).toEqual({ event: 'stop', reason: 'caller-hangup' });
      } finally {
        child.kill('SIGKILL');
        await media.stop();
      }
    });
  },
);
