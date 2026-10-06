// Load test for one VM: N concurrent fake-carrier calls through the real stack and fixture providers.
//
//   OVO_TEST_POSTGRES_URL=postgres://… scripts/loadtest/loadtest.sh [--calls 8] [--hold-ms 15000] [--json]
//
// The API, gateway, dispatcher and worker-1 run in this process (tests/e2e/support/stack.ts), with
// workers 2..N as child processes like Compose worker containers. Every provider host is routed to
// a loopback fake; nothing reaches Twilio, OpenAI or AssemblyAI. See tests/load/README.md.
import { parseArgs } from 'node:util';
import {
  startFakeAssemblyAi,
  startFakeOpenAi,
  startFakeTwilioRest,
} from '../../tests/e2e/support/fake-providers.ts';
import {
  carrierUrls,
  configureInboundAgent,
  operatorApi,
} from '../../tests/e2e/support/operator-setup.ts';
import { startLiveStack } from '../../tests/e2e/support/stack.ts';
import { runCall, type CallResult } from './calls.ts';
import {
  connectionCount,
  estimateCapacity,
  maxConnections,
  percentile,
  usageDuring,
  type PostgresConnections,
  type Sample,
} from './capacity.ts';
import { formatLoadReport, type LoadReport } from './report.ts';
import { startWorkers } from './workers.ts';

export { formatLoadReport, type LoadReport } from './report.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CALLER = 'Hello, I want to talk about my loan payment.';
const REPLY = 'Hello, thanks for calling. How can I help you with your loan today?';

export async function runLoad(input: {
  postgresUrl: string;
  calls: number;
  holdMs: number;
  log?: (line: string) => void;
}): Promise<LoadReport> {
  const log = input.log ?? (() => undefined);
  const samples: Sample[] = [];
  const openAi = await startFakeOpenAi(REPLY);
  const assemblyAi = await startFakeAssemblyAi({
    beginDelayMs: 300,
    speechBytes: 8_000,
    transcript: CALLER,
  });
  const twilioRest = await startFakeTwilioRest();
  process.env.OVO_LOADTEST_ROUTES = JSON.stringify({
    'api.openai.com': openAi.server.origin,
    'streaming.assemblyai.com': assemblyAi.server.origin,
    'streaming.us.assemblyai.com': assemblyAi.server.origin,
    'api.twilio.com': twilioRest.server.origin,
  });
  const stack = await startLiveStack(input.postgresUrl);
  const connections = () => connectionCount(stack.db);
  const postgres: PostgresConnections = {
    maxConnections: await maxConnections(stack.db),
    controlPlane: await connections(),
    withIdleWorkers: 0,
    peak: 0,
    workers: input.calls,
  };
  const workers = await startWorkers(input.calls - 1, input.calls, samples);
  let sampler: NodeJS.Timeout | undefined;
  try {
    const agent = await configureInboundAgent(stack.operator);
    const api = operatorApi(stack.operator);
    log(`waiting for ${input.calls} ready workers`);
    for (const deadline = Date.now() + 90_000; ; await sleep(500)) {
      const failed = stack.worker.status.state === 'failed' ? stack.worker.status.detail : '';
      if (failed) throw new Error(`worker-1 failed: ${failed}`);
      const { readyProtected } = await api<{ readyProtected: number }>(
        'GET',
        '/v1/operations/inbound/capacity',
      );
      if (readyProtected >= input.calls) {
        postgres.withIdleWorkers = await connections();
        break;
      }
      if (Date.now() > deadline)
        throw new Error(`only ${readyProtected} of ${input.calls} workers became ready`);
    }
    let cpu = process.cpuUsage();
    let at = performance.now();
    sampler = setInterval(() => {
      void connections().then(
        (count) => (postgres.peak = Math.max(postgres.peak, count)),
        () => undefined, // swallow-ok: a sample lost while the pool is exhausted is not a result.
      );
      const used = process.cpuUsage(cpu);
      const now = performance.now();
      samples.push({
        process: 'parent',
        atMs: Date.now(),
        cpuPercent: ((used.user + used.system) / 1000 / (now - at)) * 100,
        rssBytes: process.memoryUsage().rss,
      });
      cpu = process.cpuUsage();
      at = now;
    }, 500);
    const urls = await carrierUrls(stack.operator, agent.twilioBindingId);
    const plan = {
      gateway: stack.gateway,
      account: agent,
      to: agent.number,
      urls,
      holdMs: input.holdMs,
      replyTimeoutMs: 30_000,
    };
    log(`starting ${input.calls} calls`);
    const startedAt = Date.now();
    // Calls arrive 100 ms apart, as a burst of real callers would, and overlap for holdMs.
    const results: CallResult[] = await Promise.all(
      Array.from({ length: input.calls }, async (_, index) => {
        await sleep(index * 100);
        return runCall(index, plan);
      }),
    );
    // Every call is up, speaking or holding, from the last ring until holdMs after the first.
    const window = { fromMs: startedAt + input.calls * 100, toMs: startedAt + input.holdMs };
    const turns = await turnLatencies(stack, results);
    const processes = usageDuring(samples, window);
    const workerUsage = processes.filter((usage) => usage.process.startsWith('worker-'));
    const reached = results.flatMap((result) =>
      result.firstAgentAudioMs === null ? [] : [result.firstAgentAudioMs],
    );
    return {
      calls: input.calls,
      completed: results.filter((result) => result.ok).length,
      failures: results.flatMap((result) =>
        result.ok ? [] : [{ index: result.index, error: result.error ?? 'unknown' }],
      ),
      firstAgentAudioMs: {
        p50: percentile(reached, 50),
        p95: percentile(reached, 95),
        max: reached.length ? Math.max(...reached) : null,
      },
      turnFirstAudioMs: { p50: percentile(turns, 50), p95: percentile(turns, 95) },
      processes,
      postgres,
      capacity: estimateCapacity(workerUsage, postgres),
    };
  } finally {
    clearInterval(sampler);
    await workers.stop();
    await stack.close();
    await Promise.all([openAi, assemblyAi, twilioRest].map((fake) => fake.server.close()));
  }
}

/** Each answered call's caller-turn first-audio latency, from the worker's own turn telemetry. */
async function turnLatencies(
  stack: Awaited<ReturnType<typeof startLiveStack>>,
  results: readonly CallResult[],
): Promise<number[]> {
  const api = operatorApi(stack.operator);
  const latencies: number[] = [];
  for (const result of results) {
    const { rows } = await stack.db.query<{ call_id: string | null; job_id: string }>(
      `SELECT j.payload->>'callId' AS call_id, r.job_id FROM ovo_session_routes r
       JOIN ovo_jobs j ON j.id = r.job_id WHERE r.carrier_call_id = $1`,
      [result.callSid],
    );
    const id = rows[0]?.call_id ?? rows[0]?.job_id;
    if (!id) continue;
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(250)) {
      const { turns } = await api<{ turns: { input: string; firstAudioMs: number | null }[] }>(
        'GET',
        `/v1/calls/${id}/turns`,
      ).catch(() => ({ turns: [] }));
      const speech = turns.find((turn) => turn.input === 'speech' && turn.firstAudioMs !== null);
      if (speech) {
        latencies.push(speech.firstAudioMs!);
        break;
      }
    }
  }
  return latencies;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      calls: { type: 'string', default: '4' },
      'hold-ms': { type: 'string', default: '15000' },
      json: { type: 'boolean', default: false },
    },
  });
  const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
  if (!postgresUrl) throw new Error('OVO_TEST_POSTGRES_URL is required (a scratch database)');
  const calls = Number(values.calls);
  if (!Number.isInteger(calls) || calls < 1 || calls > 16)
    throw new Error('--calls must be 1 to 16 (the fixture budget admits 20 reservations)');
  const report = await runLoad({
    postgresUrl,
    calls,
    holdMs: Number(values['hold-ms']),
    log: (line) => console.error(line),
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatLoadReport(report));
  if (report.completed !== report.calls) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().then(
    () => process.exit(),
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      process.exit(1);
    },
  );
