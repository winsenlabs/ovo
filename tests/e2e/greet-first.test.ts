import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MULAW_8K } from '../../packages/contracts/src/index.ts';
import { startLoopbackServer } from '../../packages/conformance/src/drivers/loopback-server.ts';
import { openAiTtsTemplate } from '../../packages/plugin-tts-openai/src/testing.ts';
import { startFakeAssemblyAi, startFakeTwilioRest } from './support/fake-providers.ts';
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
  throw new Error('The greet-first test needs OVO_TEST_POSTGRES_URL (a database for schemas)');

// Inside the STT connect timeout, but long enough that a greeting waiting on Begin is obvious.
const STT_BEGIN_MS = 2_500;
const OPENING = 'Hello {{name}}, this is the live path line.';
const GREETING = 'Hello Ravi, this is the live path line.';
const GOODBYE = 'Thanks Ravi, goodbye.';

/**
 * OpenAI speech plus a Responses stream whose only answer is the built-in `end_call` tool, in the
 * wire shape plugin-llm-openai's own fixtures record (output_item.added, arguments.done,
 * output_item.done, completed).
 */
async function startEndingOpenAi() {
  const speech: { text: string; at: number }[] = [];
  const responses: string[] = [];
  const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
  const server = await startLoopbackServer({
    onRequest(request, response) {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const json = JSON.parse(raw) as { input?: string; stream?: boolean };
        if (request.method === 'POST' && request.url === '/v1/audio/speech') {
          speech.push({ text: String(json.input), at: Date.now() });
          const [script] = openAiTtsTemplate({
            format: MULAW_8K,
            language: 'en',
            sessionId: 'greet-first',
            turns: [],
            agentTexts: [String(json.input)],
          });
          const step = script?.steps[0];
          if (!step || !('reply' in step)) throw new Error('TTS fixture template changed shape');
          response.writeHead(step.reply.status, step.reply.headers).end(step.reply.body);
          return;
        }
        if (request.method === 'POST' && request.url === '/v1/responses' && json.stream) {
          responses.push(raw);
          const id = `resp-greet-first-${responses.length}`;
          const call = {
            type: 'function_call',
            id: 'fc-1',
            call_id: 'call-1',
            name: 'end_call',
            arguments: JSON.stringify({ goodbye: GOODBYE, reason: 'caller-done' }),
          };
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'x-request-id': `llm-greet-first-${responses.length}`,
          });
          response.end(
            sse({
              type: 'response.created',
              response: { id, created_at: 0, model: 'gpt-6-luna' },
            }) +
              sse({ type: 'response.output_item.added', output_index: 0, item: call }) +
              sse({
                type: 'response.function_call_arguments.done',
                output_index: 0,
                item_id: 'fc-1',
                name: 'end_call',
                arguments: call.arguments,
              }) +
              sse({
                type: 'response.output_item.done',
                output_index: 0,
                item: { ...call, status: 'completed' },
              }) +
              sse({
                type: 'response.completed',
                response: { id, usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 } },
              }),
          );
          return;
        }
        response.writeHead(404).end();
      })().catch((error: unknown) => response.writeHead(500).end(String(error)));
    },
  });
  return { server, speech, responses };
}

/** The live-path agent, now greeting first by name and allowed to end the call itself. */
async function makeGreetFirst(stack: LiveStack, agent: InboundAgent): Promise<void> {
  const api = operatorApi(stack.operator);
  const current = await api<{ config: Record<string, unknown>; draftVersion: number }>(
    'GET',
    `/v1/agents/${agent.agentId}`,
  );
  const updated = await stack.operator.app.inject({
    method: 'PUT',
    url: `/v1/agents/${agent.agentId}`,
    remoteAddress: '172.29.240.10',
    headers: {
      'x-forwarded-proto': 'https',
      cookie: stack.operator.cookie,
      'if-match': `"${current.draftVersion}"`,
    },
    payload: {
      config: {
        ...current.config,
        context: 'You are calling {{name}}. Reply in short spoken sentences.',
        variables: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
          additionalProperties: false,
        },
        opening: { lines: [OPENING] },
        ending: { llmTool: true },
      },
    },
  });
  if (updated.statusCode !== 200) throw new Error(`agent update: ${updated.body}`);
  const release = await api<{ id: string }>('POST', `/v1/agents/${agent.agentId}/releases`, {});
  const { items } = await api<{ items: { phoneNumber: string; version: number }[] }>(
    'GET',
    '/v1/operations/inbound/routes',
  );
  const route = items.find((item) => item.phoneNumber === agent.number);
  await api('PUT', `/v1/operations/inbound/routes/${encodeURIComponent(agent.number)}`, {
    expectedVersion: route?.version ?? null,
    releaseId: release.id,
    variables: { name: 'Ravi' },
    enabled: true,
    carrierPluginId: '@winsendotai/ovo-carrier-twilio',
    carrierBindingId: agent.twilioBindingId,
  });
}

describe('greet-first agent call: opening before STT, call facts, and the agent hangs up', () => {
  let stack: LiveStack;
  let agent: InboundAgent;
  let openAi: Awaited<ReturnType<typeof startEndingOpenAi>>;
  let assemblyAi: Awaited<ReturnType<typeof startFakeAssemblyAi>>;
  let twilioRest: Awaited<ReturnType<typeof startFakeTwilioRest>>;

  beforeAll(async () => {
    openAi = await startEndingOpenAi();
    assemblyAi = await startFakeAssemblyAi({
      beginDelayMs: STT_BEGIN_MS,
      speechBytes: 8_000,
      transcript: 'No, that is all, thank you.',
    });
    twilioRest = await startFakeTwilioRest();
    net.routes.set('api.openai.com', openAi.server.origin);
    net.routes.set('streaming.assemblyai.com', assemblyAi.server.origin);
    net.routes.set('api.twilio.com', twilioRest.server.origin);
    stack = await startLiveStack(postgresUrl);
    agent = await configureInboundAgent(stack.operator);
    await makeGreetFirst(stack, agent);
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

  it('greets by name before STT Begin, then ends the call completed after the goodbye', async () => {
    const urls = await carrierUrls(stack.operator, agent.twilioBindingId);
    const call = new FakeTwilioCall(stack.gateway, agent, {
      from: '+919800000002',
      to: agent.number,
    });
    // A silent line: the fake STT transcribes by byte count, and silence never barges in.
    call.fallSilent();
    try {
      const answer = await call.ring(urls.voice);
      expect(answer.status).toBe(200);
      await call.connect(answer.twiml);

      // LAT-2 + AGT-2/5: the rendered opening is synthesised and its audio reaches the caller
      // while the STT handshake is still waiting for Begin.
      await vi.waitFor(
        () => {
          expect(openAi.speech[0]?.text).toBe(GREETING);
          expect(call.agentAudioBytes).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 50 },
      );
      expect(assemblyAi.sessions.every((session) => session.begunAt === undefined)).toBe(true);

      // The caller's turn reaches the LLM with the call facts; it answers with end_call (AGT-3).
      await vi.waitFor(() => expect(openAi.speech.map((item) => item.text)).toContain(GOODBYE), {
        timeout: 20_000,
        interval: 100,
      });
      expect(openAi.responses[0]).toContain('name: Ravi');
      expect(openAi.responses[0]).toContain('You are calling Ravi.');
      expect(openAi.responses[0]).toContain('"end_call"');

      // Once the goodbye has played the agent hangs up through Twilio's REST API.
      await vi.waitFor(
        () =>
          expect(
            twilioRest.requests.some(
              (request) =>
                request.method === 'POST' &&
                request.url.includes(`/Calls/${call.callSid}.json`) &&
                request.body.includes('Status=completed'),
            ),
          ).toBe(true),
        { timeout: 15_000, interval: 100 },
      );
      expect(await call.hangUp(urls.status)).toBe(204);
      const route = async () =>
        (
          await stack.db.query<{
            job_id: string;
            terminal_reason: string | null;
            status: string;
          }>(
            'SELECT job_id, terminal_reason, status FROM ovo_session_routes WHERE carrier_call_id = $1',
            [call.callSid],
          )
        ).rows[0];
      await vi.waitFor(
        async () => {
          const settled = await route();
          expect(settled?.terminal_reason).toBe('behavior_completed');
          expect(settled?.status).toBe('completed');
        },
        { timeout: 15_000 },
      );
      const { rows } = await stack.db.query<{ call_id: string | null }>(
        "SELECT payload->>'callId' AS call_id FROM ovo_jobs WHERE id = $1",
        [(await route())!.job_id],
      );
      await vi.waitFor(
        async () => {
          const record = await operatorApi(stack.operator)<{ status: string }>(
            'GET',
            `/v1/calls/${rows[0]?.call_id ?? (await route())!.job_id}`,
          );
          expect(record.status).toBe('completed');
        },
        { timeout: 15_000, interval: 250 },
      );
    } finally {
      call.close();
    }
  }, 90_000);
});
