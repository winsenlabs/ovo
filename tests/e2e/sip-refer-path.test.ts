import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACD_HOST } from './support/fake-acd.ts';
import { humanStack, holdPolicy, type HumanStack } from './support/human-setup.ts';
import { at, capacityReady, of, outcomeOf, ticketOf } from './support/human-call.ts';
import { runReferScenario, tracedMessages } from './support/sip-refer.ts';
import {
  SIP_GATEWAY_MAIN,
  startSipGatewayProcess,
  type SipGatewayProcess,
} from './support/sip-setup.ts';
import { freePort } from './support/stack.ts';

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

const ROOT = new URL('../..', import.meta.url).pathname;
const sipp = process.env.OVO_TEST_SIPP;
const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (sipp && !postgresUrl)
  throw new Error('The SIP REFER test needs OVO_TEST_POSTGRES_URL as well as OVO_TEST_SIPP');
if (sipp && !existsSync(join(ROOT, SIP_GATEWAY_MAIN)))
  throw new Error(`OVO_TEST_SIPP is set but ${SIP_GATEWAY_MAIN} does not exist`);

const RTP_PORTS = { min: 41500, max: 41599 };
const SIP_URI = `sips:desk@sip.${ACD_HOST}`;

describe.skipIf(!sipp)('SIP REFER of a human queue handoff (R3)', () => {
  let env: HumanStack;
  let dir: string;
  let gateway: SipGatewayProcess | undefined;

  const startGateway = async (refer: Parameters<typeof startSipGatewayProcess>[0]['refer']) => {
    await gateway?.close();
    gateway = await startSipGatewayProcess({
      root: ROOT,
      dir,
      variables: env.stack.variables,
      gatewayOrigin: env.stack.gateway.origin,
      controlPort: controlPort,
      agent: env.sipAgent!,
      rtpPorts: RTP_PORTS,
      refer,
      env: { OVO_SIP_REFER_TIMEOUT_MS: '2000' },
    });
  };
  let controlPort = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ovo-sip-refer-'));
    controlPort = await freePort();
    env = await humanStack(postgresUrl!, net.routes, {
      sip: { controlPort },
      line: { external: { hold: holdPolicy(30) } },
    });
    await startGateway({ enabled: true, allowedHosts: [`.${ACD_HOST}`] });
  }, 120_000);

  afterAll(async () => {
    await gateway?.close();
    await env?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** One SIPp call through the router to the desk queue; resolves with what SIPp saw. */
  async function call(scenario: string) {
    await capacityReady(env);
    const run = runReferScenario(sipp!, scenario, {
      target: `127.0.0.1:${gateway!.sipPort}`,
      localPort: await freePort(),
      mediaPort: await freePort(),
      did: env.sipAgent!.number,
    });
    try {
      await vi.waitFor(() => expect(env.stt.open().length).toBeGreaterThan(0), {
        timeout: 15_000,
        interval: 100,
      });
    } catch (error) {
      run.kill();
      const out = await run.done;
      console.log(
        'INFO sipp-timeout',
        out.code,
        out.errors.slice(0, 800),
        out.messages.slice(0, 1500),
        'OUT',
        out.output.slice(-1500),
      );
      console.log('INFO gateway', gateway!.output().slice(-2500));
      throw error;
    }
    env.stt.say('I have a strange question');
    const result = await run.done;
    const callId = /^Call-ID: (.+)$/m.exec(result.messages)?.[1]?.trim();
    expect(callId, 'SIPp traced no Call-ID').toBeTruthy();
    const route = await vi.waitFor(
      async () => {
        const rows = await env.stack.db.query<{ job_id: string }>(
          'SELECT job_id FROM ovo_session_routes WHERE carrier_call_id = $1',
          [callId],
        );
        expect(rows.rows[0]).toBeTruthy();
        return rows.rows[0]!;
      },
      { timeout: 10_000 },
    );
    return { result, jobId: route.job_id };
  }

  /** The finished call as the inspector shows it. */
  async function finished(jobId: string) {
    let outcome!: Awaited<ReturnType<typeof outcomeOf>>;
    await vi.waitFor(
      async () => {
        outcome = await outcomeOf(env, jobId);
        expect(outcome.events.some((event) => event.type === 'call.outcome')).toBe(true);
        // The summary is folded from the events a moment after the event is stored.
        expect(outcome.summary.outcome).not.toBeNull();
      },
      { timeout: 30_000, interval: 250 },
    );
    return outcome;
  }

  const ACCEPT = {
    status: 200,
    json: {
      result: 'ok',
      dial: { uri: SIP_URI, headers: { 'X-Acd-Ticket': 'T-9', 'X-Evil': 'x' } },
    },
  };

  it('5a. REFER confirmed: the destination gets the context headers and the call ends transferred', async () => {
    env.acd.reply(ACCEPT);
    const before = env.acd.requests.length;
    const { result, jobId } = await call('uac-refer-accepted');
    expect(result.code, `${result.errors}\n${result.output}`).toBe(0);
    const ticket = ticketOf(env, env.acd.deliveries().length - 1);
    const refers = tracedMessages(result.messages, /^REFER /);
    expect(refers).toHaveLength(1);
    const referTo = /^Refer-To: <(.+)>$/m.exec(refers[0]!)?.[1] ?? '';
    const url = new URL(referTo.replace(/^sips:/, 'sips://'));
    expect(`${url.protocol}//${url.username}@${url.host}`).toBe(`sips://desk@sip.${ACD_HOST}`);
    // The allow-listed header of the answer and OVO's own ids travel; the unlisted one is dropped.
    expect(url.searchParams.get('X-Acd-Ticket')).toBe('T-9');
    expect(url.searchParams.get('X-OVO-Ticket')).toBe(ticket);
    expect(url.searchParams.get('X-OVO-Call-Id')).toBe(jobId);
    expect(url.searchParams.get('X-OVO-Context-Url')).toContain(`/human-queue/context/${ticket}`);
    expect(referTo).not.toContain('X-Evil');
    expect(refers[0]).toContain('Referred-By: <sip:ovo@127.0.0.1>');
    // The gateway said BYE after the final NOTIFY (the scenario would not have passed otherwise).
    expect(tracedMessages(result.messages, /^BYE /)).toHaveLength(1);
    const { events, summary } = await finished(jobId);
    at(events, 'human.state', { state: 'handed_off' });
    at(events, 'human.completed', { outcome: 'handed_off' });
    at(events, 'call.outcome', { outcome: 'transferred' });
    expect(summary).toMatchObject({ outcome: 'transferred' });
    expect(summary.human).toMatchObject({ kind: 'external', outcome: 'handed_off' });
    // Only the delivery: the third party was never told the call was cancelled.
    expect(env.acd.requests.slice(before)).toHaveLength(1);
    expect(of(events, 'human.webhook').map((event) => event.payload.outcome)).toEqual([
      'delivered',
      'accepted',
    ]);
  });

  /** A handoff the carrier refused or failed: the caller was kept, the third party told, the chain ran. */
  function expectKept(
    outcome: Awaited<ReturnType<typeof finished>>,
    result: Awaited<ReturnType<typeof call>>['result'],
    sent: number,
  ) {
    const { events, summary } = outcome;
    at(events, 'human.state', { state: 'released', code: 'abandoned' });
    at(events, 'human.completed', { outcome: 'failed' });
    at(events, 'segment.ended', { role: 'human', ended: 'start_failed' });
    expect(of(events, 'human.state').some((event) => event.payload.state === 'handed_off')).toBe(
      false,
    );
    // The caller ended the way an unconnected queue ends it: the callback promise, then the hang-up.
    expect(summary).toMatchObject({ outcome: 'completed', disposition: 'callback' });
    expect(tracedMessages(result.messages, /^BYE /)).toHaveLength(1);
    // The third party got its delivery and then the best-effort cancel.
    expect(env.acd.requests.slice(-sent)).toHaveLength(sent);
    expect(env.acd.requests.at(-1)!.json).toMatchObject({ event: 'cancelled' });
  }

  it('5b. NOTIFY 503: the transfer failed, the caller stays and the chain continues', async () => {
    env.acd.reply(ACCEPT);
    const { result, jobId } = await call('uac-refer-notify-503');
    expect(result.code, `${result.errors}\n${result.output}`).toBe(0);
    expect(tracedMessages(result.messages, /^REFER /)).toHaveLength(1);
    expectKept(await finished(jobId), result, 2);
  });

  it('5c. no NOTIFY at all: the receipt is unknown, so the call counts as handed off and ends transferred', async () => {
    env.acd.reply(ACCEPT);
    const before = env.acd.requests.length;
    const { result, jobId } = await call('uac-refer-silent');
    expect(result.code, `${result.errors}\n${result.output}`).toBe(0);
    expect(tracedMessages(result.messages, /^REFER /)).toHaveLength(1);
    const { events, summary } = await finished(jobId);
    const handedOff = at(events, 'human.state', { state: 'handed_off', code: 'unknown_receipt' });
    at(events, 'human.completed', { outcome: 'handed_off' });
    at(events, 'call.outcome', { outcome: 'transferred' });
    expect(handedOff).toBeGreaterThan(-1);
    expect(summary).toMatchObject({ outcome: 'transferred' });
    // An unknown receipt may have moved the call: the third party is not told it was cancelled.
    expect(env.acd.requests.slice(before)).toHaveLength(1);
  });

  it('5d. a trunk with REFER disabled: nothing is sent, the handoff is refused and the caller is kept', async () => {
    await startGateway({ enabled: false });
    env.acd.reply(ACCEPT);
    const { result, jobId } = await call('uac-refer-never');
    expect(result.code, `${result.errors}\n${result.output}`).toBe(0);
    expect(tracedMessages(result.messages, /^REFER /)).toHaveLength(0);
    expectKept(await finished(jobId), result, 2);
  });
});
