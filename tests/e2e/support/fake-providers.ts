import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MULAW_8K } from '../../../packages/contracts/src/index.ts';
import { startLoopbackServer } from '../../../packages/conformance/src/drivers/loopback-server.ts';
import { openAiTtsTemplate } from '../../../packages/plugin-tts-openai/src/testing.ts';

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

/** OpenAI speech and Responses endpoints. Speech replies are the plugin's documented SSE stream. */
export async function startFakeOpenAi(reply: string) {
  const speech: string[] = [];
  let responses = 0;
  const server = await startLoopbackServer({
    onRequest(request, response) {
      void (async () => {
        const json = JSON.parse(await body(request)) as { input?: string; stream?: boolean };
        if (request.method === 'POST' && request.url === '/v1/audio/speech') {
          speech.push(String(json.input));
          const [script] = openAiTtsTemplate({
            format: MULAW_8K,
            language: 'en',
            sessionId: 'live-path',
            turns: [],
            agentTexts: [String(json.input)],
          });
          const step = script?.steps[0];
          if (!step || !('reply' in step)) throw new Error('TTS fixture template changed shape');
          // Ends with `data: [DONE]`, as the live API does (c201818).
          response.writeHead(step.reply.status, step.reply.headers).end(step.reply.body);
          return;
        }
        if (request.method === 'POST' && request.url === '/v1/responses' && json.stream) {
          responses += 1;
          const id = `resp-live-path-${responses}`;
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'x-request-id': `llm-live-path-${responses}`,
          });
          response.write(
            sse({
              type: 'response.created',
              response: { id, created_at: 0, model: 'gpt-6-luna' },
            }) +
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
          response.end(
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
  return { server, speech, responses: () => responses };
}

/**
 * AssemblyAI v3 streaming: Begin only after `beginDelayMs` (the live handshake took 2-5s from
 * asia-south1), then one caller turn once `speechBytes` of audio arrived.
 */
export async function startFakeAssemblyAi(input: {
  beginDelayMs: number;
  speechBytes: number;
  transcript: string;
}) {
  const sessions: { url: string; audioBytes: number; begunAt?: number }[] = [];
  let heard = false;
  const server = await startLoopbackServer({
    onConnection(socket, request) {
      const session: (typeof sessions)[number] = { url: request.url ?? '', audioBytes: 0 };
      sessions.push(session);
      const send = (event: unknown) => socket.send(JSON.stringify(event));
      const begin = setTimeout(() => {
        session.begunAt = Date.now();
        send({ type: 'Begin', id: 'live-path-stt', expires_at: '2099-01-01T00:00:00Z' });
      }, input.beginDelayMs);
      let spoken = false;
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          session.audioBytes += (data as Buffer).byteLength;
          if (spoken || session.audioBytes < input.speechBytes) return;
          spoken = true;
          send({ type: 'SpeechStarted', timestamp: 0 });
          const words = input.transcript.split(' ');
          send({ type: 'Turn', turn_order: 0, transcript: words[0], end_of_turn: false });
          send({
            type: 'Turn',
            turn_order: 0,
            transcript: input.transcript,
            end_of_turn: true,
            turn_is_formatted: false,
            end_of_turn_confidence: 0.95,
          });
          heard = true;
          return;
        }
        const message = JSON.parse(String(data)) as { type?: string };
        if (message.type === 'Terminate') {
          send({ type: 'Termination', session_duration_seconds: 1 });
          socket.close(1000);
        }
      });
      socket.on('close', () => clearTimeout(begin));
    },
  });
  return { server, sessions, transcribed: () => heard };
}

/** Twilio's REST API: records every request (a hangup is a POST to Calls/<sid>.json). */
export async function startFakeTwilioRest() {
  const requests: { method: string; url: string; body: string; at: number }[] = [];
  const server = await startLoopbackServer({
    onRequest(request, response) {
      void body(request).then((text) => {
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          body: text,
          at: Date.now(),
        });
        const sid = /Calls\/(CA\w+)\.json/.exec(request.url ?? '')?.[1] ?? 'CA0';
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ sid, status: 'completed' }));
      });
    },
  });
  return { server, requests };
}

/** An SQS JSON-protocol endpoint with an empty queue: inbound calls never use the job queue. */
export async function startFakeSqs(): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    void body(request).then(() => {
      const empty = () =>
        response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' }).end('{}');
      if (String(request.headers['x-amz-target']).endsWith('.ReceiveMessage'))
        setTimeout(empty, 250);
      else empty();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
