import type { IncomingMessage } from 'node:http';
import { MULAW_8K } from '../../../packages/contracts/src/index.ts';
import { startLoopbackServer } from '../../../packages/conformance/src/drivers/loopback-server.ts';
import { openAiTtsTemplate } from '../../../packages/plugin-tts-openai/src/testing.ts';

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

type Socket = Parameters<
  NonNullable<NonNullable<Parameters<typeof startLoopbackServer>[0]>['onConnection']>
>[0];

const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

/** One scripted classifier answer: the `ovo_route` tool input the router's LLM returns. */
export interface RouteAnswer {
  branch: string | null;
  confidence: number;
  language?: string;
}

interface ResponsesRequest {
  input?: unknown;
  stream?: boolean;
  tools?: { name?: string }[];
}

/**
 * OpenAI speech and Responses for a routed call. A Responses request that offers the reserved
 * `ovo_route` tool is the router's classifier: it gets the next scripted answer as a function call
 * (the stream shape plugin-llm-openai's own fixture template uses). Any other request is an agent
 * turn and gets `reply` as text. Every synthesised line is kept, so a test can see who spoke.
 */
export async function startRoutingOpenAi(reply: string) {
  const speech: string[] = [];
  const answers: RouteAnswer[] = [];
  let classifierRequests = 0;
  let responses = 0;
  const server = await startLoopbackServer({
    onRequest(request, response) {
      void (async () => {
        const json = JSON.parse(await body(request)) as ResponsesRequest & { input?: string };
        if (request.method === 'POST' && request.url === '/v1/audio/speech') {
          speech.push(String(json.input));
          const [script] = openAiTtsTemplate({
            format: MULAW_8K,
            language: 'en',
            sessionId: 'routing-path',
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
        responses += 1;
        const id = `resp-routing-${responses}`;
        const usage = { input_tokens: 40, output_tokens: 20, total_tokens: 60 };
        const classifier = json.tools?.some((tool) => tool.name === 'ovo_route') === true;
        if (classifier) classifierRequests += 1;
        const answer = classifier
          ? (answers.shift() ?? { branch: null, confidence: 0 })
          : undefined;
        const call = {
          type: 'function_call',
          id: `fc-${responses}`,
          call_id: `call-${responses}`,
          name: 'ovo_route',
          arguments: JSON.stringify(answer),
        };
        if (!json.stream) {
          // The classifier asks for one whole step (Inference.generate): a JSON Responses body.
          const output = answer
            ? [call]
            : [
                {
                  type: 'message',
                  role: 'assistant',
                  id: `msg-${responses}`,
                  content: [{ type: 'output_text', text: reply, annotations: [] }],
                },
              ];
          response
            .writeHead(200, {
              'content-type': 'application/json',
              'x-request-id': `llm-routing-${responses}`,
            })
            .end(JSON.stringify({ id, created_at: 0, model: 'gpt-6-luna', output, usage }));
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-request-id': `llm-routing-${responses}`,
        });
        response.write(
          sse({ type: 'response.created', response: { id, created_at: 0, model: 'gpt-6-luna' } }),
        );
        if (answer) {
          response.write(
            sse({ type: 'response.output_item.added', output_index: 0, item: call }) +
              sse({
                type: 'response.function_call_arguments.done',
                output_index: 0,
                item_id: call.id,
                name: call.name,
                arguments: call.arguments,
              }) +
              sse({
                type: 'response.output_item.done',
                output_index: 0,
                item: { ...call, status: 'completed' },
              }),
          );
        } else {
          response.write(
            sse({
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'message', id: `msg-${responses}` },
            }),
          );
          for (const delta of reply.split(/(?<= )/))
            response.write(
              sse({
                type: 'response.output_text.delta',
                item_id: `msg-${responses}`,
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
    /** Queues the classifier's next answers, in order. */
    answer: (...next: RouteAnswer[]) => answers.push(...next),
    classifierRequests: () => classifierRequests,
  };
}

/**
 * AssemblyAI v3 streaming that speaks only when told to: `say(text)` emits one finished caller
 * turn on the newest open session. A routed call opens one session per segment, so the test
 * decides which segment hears the caller, and nothing is heard by accident during a handoff.
 */
export async function startScriptedAssemblyAi() {
  const sessions: { url: string; socket: Socket; audioBytes: number; closed: boolean }[] = [];
  let order = 0;
  const speak = (session: (typeof sessions)[number], text: string) => {
    const send = (event: unknown) => session.socket.send(JSON.stringify(event));
    const turn = order++;
    send({ type: 'SpeechStarted', timestamp: 0 });
    send({ type: 'Turn', turn_order: turn, transcript: text.split(' ')[0], end_of_turn: false });
    send({
      type: 'Turn',
      turn_order: turn,
      transcript: text,
      end_of_turn: true,
      turn_is_formatted: false,
      end_of_turn_confidence: 0.95,
    });
  };
  const server = await startLoopbackServer({
    onConnection(socket, request) {
      const session = { url: request.url ?? '', socket, audioBytes: 0, closed: false };
      sessions.push(session);
      const send = (event: unknown) => socket.send(JSON.stringify(event));
      send({
        type: 'Begin',
        id: `routing-stt-${sessions.length}`,
        expires_at: '2099-01-01T00:00:00Z',
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          session.audioBytes += (data as Buffer).byteLength;
          return;
        }
        const message = JSON.parse(String(data)) as { type?: string };
        if (message.type === 'Terminate') {
          send({ type: 'Termination', session_duration_seconds: 1 });
          socket.close(1000);
        }
      });
      socket.on('close', () => (session.closed = true));
    },
  });
  return {
    server,
    sessions,
    open: () => sessions.filter((session) => !session.closed),
    /** One caller turn on the newest open session. */
    say(text: string) {
      const session = sessions.filter((item) => !item.closed).at(-1);
      if (!session) throw new Error('No open STT session to speak into');
      speak(session, text);
    },
    /** One turn on a chosen session (a human segment opens one for each side of the call). */
    sayOn(session: (typeof sessions)[number], text: string) {
      speak(session, text);
    },
  };
}
