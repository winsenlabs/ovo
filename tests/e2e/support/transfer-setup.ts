import type { IncomingMessage } from 'node:http';
import { MULAW_8K } from '../../../packages/contracts/src/index.ts';
import { startLoopbackServer } from '../../../packages/conformance/src/drivers/loopback-server.ts';
import { openAiTtsTemplate } from '../../../packages/plugin-tts-openai/src/testing.ts';
import { operatorApi, type InboundAgent, type Operator } from './operator-setup.ts';
import { LINES, mainLineDraft, type RoutedAgent } from './routing-setup.ts';
import type { RouteAnswer } from './routing-fakes.ts';

const TWILIO = '@winsendotai/ovo-carrier-twilio';

/** What each segment says, so a test can tell from the synthesised speech who spoke. */
export const TRANSFER_LINES = {
  ...LINES,
  billing: 'Hello, billing here. I can see you were double charged.',
  announcement: 'Let me transfer you to the right team. Please stay on the line.',
  queue: 'All our billing colleagues are busy. Please hold.',
  holdLine: 'Thanks for holding, you will be connected shortly.',
  returned: "Sorry, I couldn't connect you. I'm still here with you. How can I help?",
  recorded: 'This call is recorded.',
  ai: 'I am an AI assistant.',
};
/** The LLM's handover summary: it must reach the target inside the data fence, never an event. */
export const SUMMARY = 'Caller was double charged for the March invoice and wants a refund.';
/** A route variable the target does not declare: it must never reach the target. */
export const UNDECLARED = 'undeclared-route-secret-7731';

/** One scripted agent turn: the LLM calls `transfer_to_agent` instead of replying. */
export interface TransferAction {
  target: string;
  summary?: string;
  reason?: string;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

/**
 * OpenAI speech and Responses for transfer calls. The router classifier (a request offering
 * `ovo_route`) gets the next scripted answer. Every other request is an agent turn, told apart by
 * the `[agent:<key>]` tag in its context: a queued transfer for that agent is answered with a
 * `transfer_to_agent` call when the tool is offered, anything else with the agent's reply text.
 */
export async function startTransferOpenAi(replies: Record<string, string>) {
  const speech: string[] = [];
  const answers: RouteAnswer[] = [];
  const transfers = new Map<string, TransferAction[]>();
  const requests: { agent: string | null; tools: string[]; body: string }[] = [];
  let count = 0;
  const server = await startLoopbackServer({
    onRequest(request, response) {
      void (async () => {
        const raw = await body(request);
        const json = JSON.parse(raw) as {
          input?: unknown;
          stream?: boolean;
          tools?: { name?: string }[];
        };
        if (request.method === 'POST' && request.url === '/v1/audio/speech') {
          speech.push(String(json.input));
          const [script] = openAiTtsTemplate({
            format: MULAW_8K,
            language: 'en',
            sessionId: 'transfer-path',
            turns: [],
            agentTexts: [String(json.input)],
          });
          const step = script?.steps[0];
          if (!step || !('reply' in step)) throw new Error('TTS fixture template changed shape');
          response.writeHead(step.reply.status, step.reply.headers).end(step.reply.body);
          return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/responses') {
          response.writeHead(404).end();
          return;
        }
        count += 1;
        const tools = (json.tools ?? []).map((tool) => String(tool.name));
        const agent = /\[agent:([a-z-]+)\]/.exec(raw)?.[1] ?? null;
        requests.push({ agent, tools, body: raw });
        const classifier = tools.includes('ovo_route');
        const action =
          !classifier && agent && tools.includes('transfer_to_agent')
            ? transfers.get(agent)?.shift()
            : undefined;
        const call = classifier
          ? { name: 'ovo_route', arguments: answers.shift() ?? { branch: null, confidence: 0 } }
          : action
            ? { name: 'transfer_to_agent', arguments: action }
            : undefined;
        const text = replies[agent ?? ''] ?? 'Sure, I can help with that.';
        const id = `resp-transfer-${count}`;
        const usage = { input_tokens: 40, output_tokens: 20, total_tokens: 60 };
        const item = call && {
          type: 'function_call',
          id: `fc-${count}`,
          call_id: `call-${count}`,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        };
        if (!json.stream) {
          const output = item
            ? [item]
            : [
                {
                  type: 'message',
                  role: 'assistant',
                  id: `msg-${count}`,
                  content: [{ type: 'output_text', text, annotations: [] }],
                },
              ];
          response
            .writeHead(200, { 'content-type': 'application/json', 'x-request-id': `llm-${count}` })
            .end(JSON.stringify({ id, created_at: 0, model: 'gpt-6-luna', output, usage }));
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-request-id': `llm-${count}`,
        });
        response.write(
          sse({ type: 'response.created', response: { id, created_at: 0, model: 'gpt-6-luna' } }),
        );
        if (item)
          response.write(
            sse({ type: 'response.output_item.added', output_index: 0, item }) +
              sse({
                type: 'response.function_call_arguments.done',
                output_index: 0,
                item_id: item.id,
                name: item.name,
                arguments: item.arguments,
              }) +
              sse({
                type: 'response.output_item.done',
                output_index: 0,
                item: { ...item, status: 'completed' },
              }),
          );
        else {
          response.write(
            sse({
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'message', id: `msg-${count}` },
            }),
          );
          for (const delta of text.split(/(?<= )/))
            response.write(
              sse({
                type: 'response.output_text.delta',
                item_id: `msg-${count}`,
                output_index: 0,
                delta,
              }),
            );
        }
        response.end(sse({ type: 'response.completed', response: { id, usage } }));
      })().catch((error: unknown) => response.writeHead(500).end(String(error)));
    },
  });
  return {
    server,
    speech,
    requests,
    answer: (...next: RouteAnswer[]) => answers.push(...next),
    /** Queues the transfers `agent`'s LLM will ask for, in order. */
    transfer(agent: string, ...next: TransferAction[]) {
      transfers.set(agent, [...(transfers.get(agent) ?? []), ...next]);
    },
    classifierRequests: () =>
      requests.filter((request) => request.tools.includes('ovo_route')).length,
  };
}
export type TransferOpenAi = Awaited<ReturnType<typeof startTransferOpenAi>>;

/**
 * A 1 s hold clip: an 8 kHz mu-law WAV whose bytes repeat a distinctive 40-byte pattern. Mu-law
 * round-trips through decode and encode unchanged (codes 0x7f and 0xff aside, which the pattern
 * avoids), so the caller hears these exact bytes when the hold plays it.
 */
export function holdClip(): { wav: Buffer; pattern: Buffer } {
  const pattern = Buffer.from(Array.from({ length: 40 }, (_, i) => 0x10 + ((i * 7) % 0x60)));
  const data = Buffer.alloc(8_000);
  for (let at = 0; at < data.length; at += pattern.length) pattern.copy(data, at);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(7, 20); // WAVE_FORMAT_MULAW
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(8_000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return { wav: Buffer.concat([header, data]), pattern };
}

export interface TransferLine {
  router: RoutedAgent;
  fallback: RoutedAgent;
  salesEn: RoutedAgent;
  salesHi: RoutedAgent;
  support: RoutedAgent;
  billing: RoutedAgent;
  routingReleaseId: string;
  routingPointId: string;
  pools: { sales: string; support: string; billing: string };
  pattern: Buffer;
}

export interface TransferLineOptions {
  /** Concurrent calls per billing member (two members). */
  billingCapacity?: number;
  maxTransfers?: number;
  /** Compliance lines: the router says the recording one; sales-en also has the AI one. */
  disclosures?: boolean;
}

const pinned = ({ agentId, releaseId }: RoutedAgent) => ({
  agentId,
  release: { kind: 'pinned' as const, releaseId },
});
const member = (id: string, agent: RoutedAgent, languages: string[], extra: object = {}) => ({
  id,
  agent: pinned(agent),
  languages,
  products: [],
  skills: [],
  priority: 50,
  enabled: true,
  ...extra,
});

/**
 * The R1 main line with a transfer catalogue (design 10.2, cut down): sales members may send a
 * caller to `billing` (a pool of two, slow-composing in tests that hold) or `another_language`
 * (a re-route to the intent node); billing may send one back to `sales` (refused as ping-pong) or
 * to a `senior` colleague. Holds play the uploaded clip and a reassurance line; a full billing
 * pool queues, then returns the caller to the agent that transferred. The router's own handoff
 * holds with the same point-level policy.
 */
export async function configureTransferLine(
  operator: Operator,
  base: InboundAgent,
  options: TransferLineOptions = {},
): Promise<TransferLine> {
  const call = operatorApi(operator);
  const voice = base.config.voice as Record<string, Record<string, unknown>>;
  const credential = await call<{ id: string }>('POST', '/v1/credentials', {
    label: 'assemblyai pro key',
    provider: 'assemblyai',
    type: 'api-key',
    environment: 'live',
    value: 'fake-aai-key',
  });
  const pro = await call<{ id: string }>('POST', '/v1/provider-bindings', {
    label: 'assemblyai pro',
    provider: 'assemblyai',
    pluginId: '@winsendotai/ovo-stt-assemblyai',
    environment: 'live',
    credentialId: credential.id,
    config: { model: 'universal-3-5-pro' },
  });
  const disclosure = options.disclosures ? { disclosure: { text: TRANSFER_LINES.recorded } } : {};
  const agent = async (key: string, config: Record<string, unknown>): Promise<RoutedAgent> => {
    const created = await call<{ id: string }>('POST', '/v1/agents', {
      config: {
        ...base.config,
        name: key,
        context: `${String(base.config.context)} [agent:${key}]`,
        ...config,
      },
    });
    const release = await call<{ id: string }>('POST', `/v1/agents/${created.id}/releases`, {});
    return { agentId: created.id, releaseId: release.id };
  };
  const strings = (...names: string[]) => ({
    type: 'object',
    properties: Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
    additionalProperties: false,
  });
  const opening = (line: string) => ({ opening: { lines: [line] } });
  const transfers = { handoff: { agents: { llmTool: true } } };
  const team = {
    router: await agent('router', {
      variables: strings('account_tier', 'secret_note'),
      ...(options.disclosures ? { compliance: disclosure } : {}),
    }),
    fallback: await agent('fallback', opening(LINES.fallback)),
    salesEn: await agent('sales-en', {
      ...opening(LINES.salesEn),
      ...transfers,
      ...(options.disclosures
        ? { compliance: { ...disclosure, disclosures: { ai: { text: TRANSFER_LINES.ai } } } }
        : {}),
    }),
    salesHi: await agent('sales-hi', {
      ...opening(LINES.salesHi),
      ...transfers,
      language: 'hi-IN',
      locale: 'hi-IN',
      voice: { ...voice, stt: { ...voice.stt, binding: pro.id } },
    }),
    support: await agent('support', opening(LINES.support)),
    billing: await agent('billing', {
      variables: strings('account_tier'),
      handoff: { agents: { llmTool: true, inbound: { greeting: 'llm' } } },
    }),
  };
  const pool = async (name: string, members: object[]) =>
    (
      await call<{ id: string }>('POST', '/v1/routing/pools', {
        definition: { name, languageFallback: [], members },
      })
    ).id;
  const sales = await pool('Sales', [
    member('sales-en', team.salesEn, ['en'], { capacity: 2 }),
    member('sales-hi', team.salesHi, ['hi'], { capacity: 2 }),
  ]);
  const support = await pool('Support', [member('support', team.support, ['en', 'hi'])]);
  const capacity = options.billingCapacity ?? 2;
  const billing = await pool('Billing', [
    member('billing-1', team.billing, ['en', 'hi'], { capacity }),
  ]);
  const { wav, pattern } = holdClip();
  const clip = await operator.app.inject({
    method: 'POST',
    url: '/v1/routing/audio?name=Hold%20music',
    remoteAddress: '172.29.240.10',
    headers: {
      'x-forwarded-proto': 'https',
      cookie: operator.cookie,
      'content-type': 'audio/wav',
    },
    payload: wav,
  });
  if (clip.statusCode !== 201)
    throw new Error(`Hold clip upload returned ${clip.statusCode}: ${clip.body}`);
  const hold = {
    steps: [
      { kind: 'clip', assetId: clip.json().id },
      { kind: 'line', line: { en: TRANSFER_LINES.holdLine } },
    ],
    loopFrom: 0,
    maxSeconds: 8,
    waitForCapacity: true,
    onTimeout: [{ kind: 'return' }, { kind: 'default' }],
  };
  const draft = {
    ...mainLineDraft(team, sales, support),
    transfer: {
      announcement: { en: TRANSFER_LINES.announcement },
      queueAnnouncement: { en: TRANSFER_LINES.queue },
      hold: { ...hold, onTimeout: [{ kind: 'default' }] },
      limits: { maxTransfers: options.maxTransfers ?? 3 },
      targets: [
        {
          key: 'billing',
          description: 'Payments, refunds, double charges',
          destination: { kind: 'pool', poolId: billing, language: 'any' },
          from: [{ kind: 'pool', poolId: sales }],
          hold,
        },
        {
          key: 'another_language',
          description: 'The caller wants to speak another language',
          destination: { kind: 'node', node: 'intent' },
          from: [{ kind: 'pool', poolId: sales }],
        },
        {
          key: 'sales',
          description: 'The caller wants to buy something',
          destination: { kind: 'pool', poolId: sales },
          from: [{ kind: 'pool', poolId: billing }],
        },
        {
          key: 'senior',
          description: 'A senior colleague',
          destination: { kind: 'same-pool', language: 'any' },
          from: [{ kind: 'pool', poolId: billing }],
        },
      ],
    },
  };
  const point = await call<{ id: string; draftVersion: number }>('POST', '/v1/routing/points', {
    draft,
  });
  const release = await call<{ id: string }>('POST', `/v1/routing/points/${point.id}/releases`, {
    expectedDraftVersion: point.draftVersion,
  });
  await call('PUT', `/v1/operations/inbound/routes/${encodeURIComponent(base.number)}`, {
    expectedVersion: 1,
    routingReleaseId: release.id,
    variables: { account_tier: 'gold', secret_note: UNDECLARED },
    enabled: true,
    carrierPluginId: TWILIO,
    carrierBindingId: base.twilioBindingId,
  });
  return {
    ...team,
    routingReleaseId: release.id,
    routingPointId: point.id,
    pools: { sales, support, billing },
    pattern,
  };
}
