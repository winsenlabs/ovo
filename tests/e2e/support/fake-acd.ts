import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { startLoopbackServer } from '../../../packages/conformance/src/drivers/loopback-server.ts';

/** The host a webhook queue names in the scenarios; `routedNodeNet` sends it to the fake below. */
export const ACD_HOST = 'acd.example.com';
/** The path the queue posts to, and the number prefixes and SIP host the queue's policy allows. */
export const ACD_PATH = '/ovo/handoff';
export const ACD_NUMBER = '+914012345678';
export const ACD_SIP = `sip:desk@sip.${ACD_HOST}`;

/** HMAC-SHA256 over `<timestamp>.<id>.<body>`, derived here from the documented scheme alone. */
export function acdSignature(secret: string, timestamp: string, id: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${id}.${body}`).digest('hex')}`;
}

export interface AcdRequest {
  /** Epoch ms the request reached the fake (the retry gaps are read from these). */
  at: number;
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
  json: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Whether OVO's signature over the exact bytes checks out against the shared secret. */
  signature: 'valid' | 'invalid' | 'missing';
  idempotencyKey: string | undefined;
  requestId: string | undefined;
  attempt: number;
}

export interface AcdReply {
  status?: number;
  json?: unknown;
  /** Answers after this many ms. */
  delayMs?: number;
}

/**
 * A third-party queue (an ACD) on loopback TLS: it verifies OVO's signature with the shared
 * secret, records every request, and answers from a script (the next reply per request, then the
 * default). It posts nothing itself; a scenario sends the signed callbacks with `signedCallback`.
 */
export async function startFakeAcd(options: {
  /** The HMAC secret the queue's webhook credential holds. */
  secret: string;
  /** What it answers when the script is empty. */
  fallback?: AcdReply;
  /** The api key the queue's `header` auth sends, if any. */
  apiKey?: { header: string; value: string };
}) {
  const requests: AcdRequest[] = [];
  const script: AcdReply[] = [];
  const fallback: AcdReply = options.fallback ?? {
    status: 200,
    json: { result: 'ok', dial: { number: ACD_NUMBER } },
  };
  const server = await startLoopbackServer({
    onRequest(request, response) {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString('utf8');
        const one = (name: string) => {
          const value = request.headers[name];
          return typeof value === 'string' ? value : undefined;
        };
        const timestamp = one('x-ovo-timestamp');
        const id = one('x-ovo-request-id');
        const given = one('x-ovo-signature');
        const signature: AcdRequest['signature'] = !given
          ? 'missing'
          : timestamp && id && given === acdSignature(options.secret, timestamp, id, body)
            ? 'valid'
            : 'invalid';
        let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
        try {
          json = JSON.parse(body) as typeof json;
        } catch {
          // A non-JSON body (a form post) is recorded as text only.
        }
        requests.push({
          at: Date.now(),
          method: request.method ?? '',
          path: request.url ?? '',
          headers: request.headers,
          body,
          json,
          signature,
          idempotencyKey: one('idempotency-key'),
          requestId: id,
          attempt: Number(one('x-ovo-attempt') ?? 1),
        });
        const keyOk =
          !options.apiKey || one(options.apiKey.header.toLowerCase()) === options.apiKey.value;
        const reply =
          !keyOk || signature !== 'valid' ? { status: 401 } : (script.shift() ?? fallback);
        if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        response
          .writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
          .end(reply.json === undefined ? '' : JSON.stringify(reply.json));
      })().catch((error: unknown) => response.writeHead(500).end(String(error)));
    },
  });
  return {
    server,
    requests,
    /** The next requests are answered with these, in order. */
    reply: (...next: AcdReply[]) => script.push(...next),
    /** Requests that were the first attempt of a delivery (a retry repeats the request id). */
    deliveries: () => requests.filter((request) => request.attempt === 1),
  };
}
export type FakeAcd = Awaited<ReturnType<typeof startFakeAcd>>;

/**
 * A signed callback as the third party sends it (`ovo.human-queue-callback/1`): the exact body
 * bytes, and headers carrying the event id, timestamp and signature. `signWith` and `at` let a
 * scenario send a forged or an old one.
 */
export function signedCallback(
  secret: string,
  event: Record<string, unknown> & { eventId: string },
  options: { signWith?: string; at?: number } = {},
) {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor((options.at ?? Date.now()) / 1000));
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-ovo-event-id': event.eventId,
      'x-ovo-timestamp': timestamp,
      'x-ovo-signature': acdSignature(options.signWith ?? secret, timestamp, event.eventId, body),
    },
  };
}
