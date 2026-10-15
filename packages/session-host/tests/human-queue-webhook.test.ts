import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backoffMs,
  redactWebhookRequest,
  retryAfterMs,
  sendCancel,
  sendWebhook,
  verifyWebhookSignature,
  type WebhookAttempt,
  type WebhookRequest,
} from '../src/human-queue/index.ts';

/**
 * A local HTTP server stands in for the third party. The client only reaches https URLs on public
 * addresses, so the tests resolve a documentation host to a public address and route the pinned
 * fetch to the local server.
 */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];

interface Hit {
  headers: IncomingMessage['headers'];
  body: string;
  at: number;
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function thirdParty(
  respond: (hit: Hit, n: number, res: import('node:http').ServerResponse) => void,
) {
  const hits: Hit[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const hit = { headers: req.headers, body: Buffer.concat(chunks).toString(), at: Date.now() };
      hits.push(hit);
      respond(hit, hits.length, res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  const fetch = ((url: string | URL, init?: RequestInit) =>
    globalThis.fetch(
      String(url).replace('https://acd.example.test', `http://127.0.0.1:${port}`),
      init,
    )) as typeof globalThis.fetch;
  return { hits, network: { lookup: publicLookup, fetch } };
}

const request = (over: Partial<WebhookRequest> = {}): WebhookRequest => ({
  url: 'https://acd.example.test/handoff',
  method: 'POST',
  contentType: 'application/json',
  body: '{"event":"handoff"}',
  secret: 'acd-secret',
  idempotencyKey: 'hq:ws:job:1',
  timeoutMs: 500,
  retry: { attempts: 3, baseMs: 100, maxMs: 1_000, deadlineMs: 10_000 },
  ...over,
});

/** Time that only moves when the client sleeps: each wait is recorded and added to the clock. */
function clock() {
  let at = 1_760_000_000_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => at,
    sleep: async (ms: number) => {
      waits.push(ms);
      at += ms;
    },
    random: () => 0.5,
  };
}

describe('the human queue webhook client (design 7.4)', () => {
  it('posts a signed body with an idempotency key and returns the parsed answer', async () => {
    const acd = await thirdParty((_hit, _n, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"status":"accepted"}');
    });
    const time = clock();
    const outcome = await sendWebhook(request(), { network: acd.network, ...time });
    expect(outcome).toEqual({ ok: true, status: 200, json: { status: 'accepted' }, attempts: 1 });
    const [hit] = acd.hits;
    expect(hit!.headers['idempotency-key']).toBe('hq:ws:job:1');
    expect(hit!.headers['content-type']).toBe('application/json');
    expect(hit!.headers['user-agent']).toBe('ovo-human-queue/1');
    expect(
      verifyWebhookSignature({
        secret: 'acd-secret',
        timestamp: String(hit!.headers['x-ovo-timestamp']),
        id: String(hit!.headers['x-ovo-request-id']),
        body: hit!.body,
        signature: String(hit!.headers['x-ovo-signature']),
        now: time.now(),
      }),
    ).toBe('ok');
  });

  it('retries a 503 with exponential backoff and the same idempotency key and request id', async () => {
    const acd = await thirdParty((_hit, n, res) => {
      res.statusCode = n < 3 ? 503 : 200;
      res.end(n < 3 ? '' : '{"status":"queued"}');
    });
    const time = clock();
    const seen: WebhookAttempt[] = [];
    const outcome = await sendWebhook(request(), {
      network: acd.network,
      ...time,
      onAttempt: (attempt) => seen.push(attempt),
    });
    expect(outcome).toMatchObject({ ok: true, attempts: 3 });
    expect(time.waits).toEqual([100, 200]);
    expect(new Set(acd.hits.map((hit) => hit.headers['idempotency-key']))).toEqual(
      new Set(['hq:ws:job:1']),
    );
    expect(new Set(acd.hits.map((hit) => hit.headers['x-ovo-request-id'])).size).toBe(1);
    expect(acd.hits.map((hit) => hit.headers['x-ovo-attempt'])).toEqual(['1', '2', '3']);
    expect(seen.map((attempt) => [attempt.outcome, attempt.status])).toEqual([
      ['retry', 503],
      ['retry', 503],
      ['delivered', 200],
    ]);
  });

  it('honours Retry-After (capped at ten seconds) and retries a 429 and a 408', async () => {
    const acd = await thirdParty((_hit, n, res) => {
      res.statusCode = n === 1 ? 429 : n === 2 ? 408 : 200;
      if (n === 1) res.setHeader('retry-after', '3');
      if (n === 2) res.setHeader('retry-after', '120');
      res.end('{}');
    });
    const time = clock();
    const outcome = await sendWebhook(
      request({ retry: { attempts: 4, baseMs: 100, maxMs: 1_000, deadlineMs: 60_000 } }),
      { network: acd.network, ...time },
    );
    expect(outcome).toMatchObject({ ok: true, attempts: 3 });
    expect(time.waits).toEqual([3_000, 10_000]);
  });

  it('fails a 4xx at once, without a retry', async () => {
    const acd = await thirdParty((_hit, _n, res) => {
      res.statusCode = 403;
      res.end('{}');
    });
    expect(await sendWebhook(request(), { network: acd.network, ...clock() })).toEqual({
      ok: false,
      reason: 'http_403',
      status: 403,
      attempts: 1,
    });
    expect(acd.hits).toHaveLength(1);
  });

  it('gives up when attempts or the deadline run out, reporting the last failure', async () => {
    const acd = await thirdParty((_hit, _n, res) => {
      res.statusCode = 502;
      res.end('');
    });
    const time = clock();
    expect(await sendWebhook(request(), { network: acd.network, ...time })).toEqual({
      ok: false,
      reason: 'http_502',
      status: 502,
      attempts: 3,
    });
    // The deadline leaves room for one wait only: the second never fits.
    const tight = clock();
    const outcome = await sendWebhook(
      request({ retry: { attempts: 5, baseMs: 600, maxMs: 5_000, deadlineMs: 1_000 } }),
      { network: acd.network, ...tight },
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'http_502' });
    expect(tight.waits).toEqual([600]);
  });

  it('treats a non-JSON 2xx as invalid, not retried; an empty 2xx body as no answer', async () => {
    const html = await thirdParty((_hit, _n, res) => res.end('<html>ok</html>'));
    expect(await sendWebhook(request(), { network: html.network, ...clock() })).toMatchObject({
      ok: false,
      reason: 'invalid',
      attempts: 1,
    });
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const empty = await thirdParty((_hit, _n, res) => {
      res.statusCode = 204;
      res.end();
    });
    expect(await sendWebhook(request(), { network: empty.network, ...clock() })).toEqual({
      ok: true,
      status: 204,
      json: undefined,
      attempts: 1,
    });
  });

  it('retries a timeout, and stops for an oversize body, a redirect and a private address', async () => {
    const slow = await thirdParty((_hit, n, res) => {
      if (n === 1) return; // never answers: the per-attempt timeout fires
      res.end('{"status":"queued"}');
    });
    const outcome = await sendWebhook(request({ timeoutMs: 80 }), {
      network: slow.network,
      ...clock(),
    });
    expect(outcome).toMatchObject({ ok: true, attempts: 2 });
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const big = await thirdParty((_hit, _n, res) => res.end(`{"x":"${'a'.repeat(20_000)}"}`));
    expect(await sendWebhook(request(), { network: big.network, ...clock() })).toMatchObject({
      ok: false,
      reason: 'oversize',
      attempts: 1,
    });
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const moved = await thirdParty((_hit, _n, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'https://elsewhere.example.test/');
      res.end();
    });
    expect(await sendWebhook(request(), { network: moved.network, ...clock() })).toMatchObject({
      ok: false,
      reason: 'redirect',
      attempts: 1,
    });

    const privateHost = vi.fn();
    expect(
      await sendWebhook(request(), {
        network: {
          lookup: async () => [{ address: '10.0.0.5', family: 4 as const }],
          fetch: privateHost,
        },
        ...clock(),
      }),
    ).toMatchObject({ ok: false, reason: 'policy', attempts: 1 });
    expect(privateHost).not.toHaveBeenCalled();
    expect(await sendWebhook(request({ url: 'http://acd.example.test/x' }), clock())).toMatchObject(
      {
        ok: false,
        reason: 'policy',
      },
    );
  });

  it('stops when the hold gives up (the abort signal), without another attempt', async () => {
    const acd = await thirdParty((_hit, _n, res) => {
      res.statusCode = 503;
      res.end();
    });
    const abort = new AbortController();
    const outcome = await sendWebhook(request({ signal: abort.signal }), {
      network: acd.network,
      ...clock(),
      sleep: async () => abort.abort(),
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'aborted' });
    expect(acd.hits).toHaveLength(1);
  });

  it('sends the cancelled post once, with a three second limit and no retry', async () => {
    const acd = await thirdParty((_hit, _n, res) => {
      res.statusCode = 503;
      res.end();
    });
    const outcome = await sendCancel(request({ timeoutMs: 10_000 }), {
      network: acd.network,
      ...clock(),
    });
    expect(outcome).toMatchObject({ ok: false, attempts: 1 });
    expect(acd.hits).toHaveLength(1);
  });
});

describe('backoff and previews', () => {
  it('doubles from the base, caps at the maximum and jitters by 20 percent', () => {
    const retry = { attempts: 5, baseMs: 500, maxMs: 2_000, deadlineMs: 15_000 };
    expect([1, 2, 3, 4].map((n) => backoffMs(retry, n, 0.5))).toEqual([500, 1_000, 2_000, 2_000]);
    expect(backoffMs(retry, 1, 0)).toBe(400);
    expect(backoffMs(retry, 1, 0.999)).toBe(600);
  });

  it('reads Retry-After as seconds or a date, capped, and ignores nonsense', () => {
    expect(retryAfterMs('2', 0)).toBe(2_000);
    expect(retryAfterMs('999', 0)).toBe(10_000);
    expect(retryAfterMs(new Date(4_000).toUTCString(), 1_000)).toBe(3_000);
    expect(retryAfterMs('soon', 0)).toBeUndefined();
    expect(retryAfterMs(null, 0)).toBeUndefined();
  });

  it('redacts credentials, query strings and the signature from a request preview', () => {
    const preview = redactWebhookRequest(
      request({
        url: 'https://user:pw@acd.example.test/handoff?token=abc#frag',
        headers: { 'x-api-key': 'k', 'x-custom-token': 'secret', 'x-region': 'in' },
        secretHeaders: ['x-custom-token'],
      }),
    );
    expect(preview.url).toBe('https://acd.example.test/handoff');
    expect(preview.headers).toMatchObject({
      'x-api-key': '<redacted>',
      'x-custom-token': '<redacted>',
      'x-region': 'in',
      'idempotency-key': 'hq:ws:job:1',
      'x-ovo-signature': 'v1=<computed per attempt>',
    });
    expect(JSON.stringify(preview)).not.toContain('acd-secret');
  });
});
