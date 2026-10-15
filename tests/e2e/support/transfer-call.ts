import { expect, vi } from 'vitest';
import { startFakeTwilioRest } from './fake-providers.ts';
import { FakeTwilioCall } from './fake-twilio-caller.ts';
import { carrierUrls, configureInboundAgent, operatorApi } from './operator-setup.ts';
import { startScriptedAssemblyAi } from './routing-fakes.ts';
import { startLiveStack, type LiveStack } from './stack.ts';
import {
  configureTransferLine,
  startTransferOpenAi,
  TRANSFER_LINES,
  type TransferLine,
  type TransferLineOptions,
} from './transfer-setup.ts';

export type SessionEvent = { type: string; payload: Record<string, unknown> };

/**
 * One installation (api, gateway, dispatcher, worker) with fake providers on loopback and a
 * transfer line bound to the live-path number. `routes` is the test's DNS override map.
 */
export async function transferStack(
  postgresUrl: string,
  routes: Map<string, string>,
  /** `defaultBound` leaves the prepare timeout at its production default (2.5 s). */
  flags: { transfer: boolean; defaultBound?: boolean },
  options: TransferLineOptions = {},
) {
  const openAi = await startTransferOpenAi({
    'sales-en': 'Sure, let me check that for you.',
    'sales-hi': 'Haan ji, batayiye.',
    billing: TRANSFER_LINES.billing,
  });
  const stt = await startScriptedAssemblyAi();
  const twilioRest = await startFakeTwilioRest();
  routes.set('api.openai.com', openAi.server.origin);
  routes.set('streaming.assemblyai.com', stt.server.origin);
  routes.set('api.twilio.com', twilioRest.server.origin);
  const stack = await startLiveStack(postgresUrl, {
    OVO_ROUTING_ENABLED: 'true',
    OVO_ROUTING_TRANSFER_ENABLED: String(flags.transfer),
    // Every composition attempt is bounded by the prepare timeout (transfer design 9, default
    // 2.5 s); the scenarios' slow knob composes in 4 s and must land within it, except where a
    // scenario lands it after the default bound on purpose.
    ...(flags.defaultBound ? {} : { OVO_ROUTING_PREPARE_TIMEOUT_MS: '6000' }),
  });
  const agent = await configureInboundAgent(stack.operator);
  const line = await configureTransferLine(stack.operator, agent, options);
  await vi.waitFor(
    () => {
      if (stack.worker.status.state === 'failed') throw new Error(stack.worker.status.detail);
      expect(stack.worker.status.state).toBe('ready');
    },
    { timeout: 30_000, interval: 100 },
  );
  await capacityReady(stack);
  return {
    stack,
    agent,
    line,
    openAi,
    stt,
    twilioRest,
    async close() {
      await stack.close();
      await Promise.all([openAi, stt, twilioRest].map((fake) => fake.server.close()));
    },
  };
}
export type TransferStack = Awaited<ReturnType<typeof transferStack>>;

/** Waits until the worker can take an inbound call again (the previous call has let go of it). */
async function capacityReady(stack: LiveStack) {
  await vi.waitFor(
    async () => {
      const capacity = await operatorApi(stack.operator)<{ readyProtected: number }>(
        'GET',
        '/v1/operations/inbound/capacity',
      );
      expect(capacity.readyProtected).toBeGreaterThanOrEqual(1);
    },
    { timeout: 15_000, interval: 250 },
  );
}

/** Where each call's speech starts in the fake's log, which a stack's calls share. */
const spokenFrom = new WeakMap<FakeTwilioCall, number>();

export async function count(stack: LiveStack, sql: string, values: unknown[] = []) {
  return Number((await stack.db.query<{ count: string }>(sql, values)).rows[0]!.count);
}

/**
 * Waits until `line` was synthesised, alone or within a longer utterance (the router says its
 * disclosure and greeting as one). A line said during a hold is followed by more hold audio, so
 * its audio never settles while the caller is held: wait for that with `heard` only after a hold.
 */
export async function said(env: TransferStack, call: FakeTwilioCall, line: string) {
  const spoken = () =>
    env.openAi.speech.slice(spokenFrom.get(call) ?? 0).filter((text) => text.includes(line));
  await vi.waitFor(
    () => expect(spoken(), `"${line}" in ${JSON.stringify(env.openAi.speech)}`).not.toEqual([]),
    {
      timeout: 30_000,
      interval: 100,
    },
  );
}

/** Waits until `line` was synthesised and its audio has finished reaching the caller. */
export async function heard(env: TransferStack, call: FakeTwilioCall, line: string) {
  await said(env, call, line);
  let bytes = -1;
  await vi.waitFor(
    () => {
      const now = call.agentAudioBytes;
      const settled = now > 0 && now === bytes;
      bytes = now;
      expect(settled, 'the line is still playing').toBe(true);
    },
    { timeout: 15_000, interval: 700 },
  );
}

/**
 * Waits until the hold clip (its byte `pattern`) reaches the caller after the first `from` bytes.
 * A hold line is rendered once and then played from the speech cache, so a later call's hold never
 * reaches the fake TTS again. The router's own handoff may start a hold for its first frames too.
 */
export async function holding(call: FakeTwilioCall, pattern: Buffer, from = 0) {
  await vi.waitFor(
    () =>
      expect(receivedAudio(call).subarray(from).includes(pattern), 'the hold clip is playing').toBe(
        true,
      ),
    { timeout: 30_000, interval: 100 },
  );
}

/** Every mu-law byte the caller received, in order. */
export function receivedAudio(call: FakeTwilioCall): Buffer {
  return Buffer.concat(
    call.received
      .filter((message) => message.event === 'media' && message.media)
      .map((message) => Buffer.from(message.media!.payload, 'base64')),
  );
}

/** The position of the first event matching `where`; a missing one fails with the event list. */
export function at(events: SessionEvent[], type: string, where: Record<string, unknown> = {}) {
  const index = events.findIndex(
    (event) =>
      event.type === type &&
      Object.entries(where).every(([key, value]) => event.payload[key] === value),
  );
  expect(index, `${type} ${JSON.stringify(where)} in ${JSON.stringify(events)}`).toBeGreaterThan(
    -1,
  );
  return index;
}

/**
 * Rings the number and lets `act` drive the call. Throughout, the one carrier leg and the one
 * media stream must stay up and the carrier must never be asked to hang up; `act` may hang up
 * itself (`hungUp`). Returns what the call left behind: its events, outcome, claims, the usage
 * segments the ledger tagged and the audio the caller heard.
 */
export async function transferCall(
  env: TransferStack,
  act: (call: FakeTwilioCall, hangUp: () => Promise<void>) => Promise<void>,
) {
  const { stack, agent } = env;
  const reservationsBefore = await count(stack, 'SELECT count(*) FROM ovo_cost_reservations');
  const urls = await carrierUrls(stack.operator, agent.twilioBindingId);
  await capacityReady(stack);
  const call = new FakeTwilioCall(stack.gateway, agent, {
    from: '+919800000001',
    to: agent.number,
  });
  spokenFrom.set(call, env.openAi.speech.length);
  let hungUp = false;
  const hangUp = async () => {
    hungUp = true;
    expect(await call.hangUp(urls.status)).toBe(204);
  };
  let audio: Buffer;
  try {
    const answer = await call.ring(urls.voice);
    expect(answer.status).toBe(200);
    await call.connect(answer.twiml);
    await act(call, hangUp);
    if (!hungUp) {
      expect(call.connected, 'the media stream closed during a transfer').toBe(true);
      expect(
        env.twilioRest.requests.filter((request) => request.url.includes(call.callSid)),
        'the carrier was asked to hang up or transfer',
      ).toEqual([]);
      await hangUp();
    }
    audio = receivedAudio(call);
  } finally {
    call.close();
  }
  const legs = await stack.db.query<{ job_id: string; session_id: string }>(
    'SELECT job_id, session_id FROM ovo_session_routes WHERE carrier_call_id = $1',
    [call.callSid],
  );
  expect(legs.rows, 'one carrier leg, one session route').toHaveLength(1);
  const { job_id: jobId, session_id: sessionId } = legs.rows[0]!;
  await vi.waitFor(
    async () => {
      const job = await stack.db.query<{ status: string }>(
        'SELECT status FROM ovo_jobs WHERE id = $1',
        [jobId],
      );
      expect(job.rows[0]?.status).toBe('completed');
    },
    { timeout: 30_000 },
  );
  expect(
    await count(
      stack,
      "SELECT count(*) FROM ovo_carrier_callbacks WHERE session_id = $1 AND status = 'session_opened'",
      [sessionId],
    ),
    'one media stream for the whole call',
  ).toBe(1);
  expect(await count(stack, 'SELECT count(*) FROM ovo_cost_reservations')).toBe(
    reservationsBefore + 1,
  );
  type Outcome = { summary: Record<string, any> | null; events: SessionEvent[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  let outcome!: Outcome;
  await vi.waitFor(
    async () => {
      outcome = await operatorApi(stack.operator)<Outcome>('GET', `/v1/calls/${jobId}/outcome`);
      expect(outcome.events.some((event) => event.type === 'call.outcome')).toBe(true);
    },
    { timeout: 20_000, interval: 250 },
  );
  const claims = await stack.db.query<{ member_id: string; released_at: Date | null }>(
    'SELECT member_id, released_at FROM ovo_routing_member_claims WHERE call_id = $1 ORDER BY claimed_at',
    [jobId],
  );
  const segments = await stack.db.query<{ segment_index: number | null }>(
    `SELECT DISTINCT segment_index FROM ovo_cost_native_usage
      WHERE call_id = $1 OR session_id = $2 ORDER BY segment_index NULLS FIRST`,
    [jobId, sessionId],
  );
  return {
    jobId,
    events: outcome.events,
    summary: outcome.summary!,
    claims: claims.rows,
    usageSegments: segments.rows.map((row) => row.segment_index),
    audio: audio!,
  };
}

export type { TransferLine };
