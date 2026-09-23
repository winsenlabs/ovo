import { describe, expect, it } from 'vitest';
import {
  ProviderProtocolError,
  createFixtureNet,
  formBody,
  httpJson,
  readBoundedJson,
  validateProviderEndpoint,
  withDeadline,
  decimal,
} from '../src/index.ts';

const reply = (status: number, body?: string) =>
  createFixtureNet([
    {
      host: 'api.example.com',
      source: 'https://docs.example.com',
      retrieved: '2026-09-22',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: 'https://api.example.com/v1/x',
          reply: { status, ...(body === undefined ? {} : { body }) },
        },
      ],
    },
  ]);

const call = (net: ReturnType<typeof reply>, signal?: AbortSignal) =>
  httpJson(
    net,
    'https://api.example.com/v1/x',
    { method: 'POST', json: { a: 1 } },
    { timeoutMs: 1000, signal },
  );

describe('httpJson', () => {
  it.each([
    [200, '{"id":"a"}', { kind: 'ok', status: 200 }],
    [201, '', { kind: 'ok', status: 201 }],
    [200, 'not json', { kind: 'unknown', status: 200 }],
    [400, '{"code":21211}', { kind: 'rejected', status: 400, retryable: false }],
    [401, '', { kind: 'rejected', status: 401, retryable: false }],
    [404, '', { kind: 'rejected', status: 404, retryable: false }],
    [408, '', { kind: 'unknown', status: 408 }],
    [429, '', { kind: 'rejected', status: 429, retryable: true }],
    [500, '', { kind: 'unknown', status: 500 }],
    [503, 'busy', { kind: 'unknown', status: 503 }],
  ])('classifies HTTP %i', async (status, body, expected) => {
    expect(await call(reply(status, body))).toMatchObject(expected);
  });

  it('keeps a rejected JSON body for the caller', async () => {
    expect(await call(reply(400, '{"code":21211}'))).toMatchObject({ body: { code: 21211 } });
  });

  it('classifies a timeout and a transport failure as unknown, and rethrows a caller abort', async () => {
    const hanging = {
      fetch: (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    };
    expect(
      await httpJson(hanging, 'https://api.example.com/v1/x', { method: 'GET' }, { timeoutMs: 20 }),
    ).toEqual({ kind: 'unknown', reason: 'timeout' });
    const broken = { fetch: async () => Promise.reject(new TypeError('fetch failed')) };
    expect(
      await httpJson(broken, 'https://api.example.com/v1/x', { method: 'GET' }, { timeoutMs: 20 }),
    ).toEqual({
      kind: 'unknown',
      reason: 'transport: TypeError',
    });
    const controller = new AbortController();
    const pending = httpJson(
      hanging,
      'https://api.example.com/v1/x',
      { method: 'GET' },
      { timeoutMs: 1000, signal: controller.signal },
    );
    controller.abort(new DOMException('caller', 'AbortError'));
    await expect(pending).rejects.toThrow('caller');
  });

  it('encodes forms with repeated keys', () => {
    expect(formBody({ To: '+1', Event: ['a', 'b'], Skip: undefined })).toBe(
      'To=%2B1&Event=a&Event=b',
    );
  });
});

describe('provider HTTP helpers', () => {
  it('validates provider endpoints', () => {
    expect(
      validateProviderEndpoint('https://api.openai.com/v1/audio/speech', '/v1/audio/speech').host,
    ).toBe('api.openai.com');
    expect(() =>
      validateProviderEndpoint('http://api.openai.com/v1/audio/speech', '/v1/audio/speech'),
    ).toThrow(/HTTPS/);
    expect(() =>
      validateProviderEndpoint('https://10.0.0.1/v1/audio/speech', '/v1/audio/speech'),
    ).toThrow(/Private/);
    expect(() =>
      validateProviderEndpoint('https://evil.example/v1/audio/speech', '/v1/audio/speech'),
    ).toThrow(/must use/);
  });

  it('bounds JSON bodies', async () => {
    await expect(readBoundedJson(new Response('{"a":1}'), 100)).resolves.toEqual({ a: 1 });
    await expect(readBoundedJson(new Response('{"a":"xxxxxxxxxxxx"}'), 5)).rejects.toBeInstanceOf(
      ProviderProtocolError,
    );
    await expect(readBoundedJson(new Response('[1]'), 100)).rejects.toThrow(/malformed/);
  });

  it('derives deadline signals and decimal quantities', async () => {
    const deadline = withDeadline(new AbortController().signal, 5, 'too slow');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deadline.signal.reason).toMatchObject({ name: 'TimeoutError' });
    deadline.dispose();
    expect(decimal(1.25)).toBe('1.25');
    expect(decimal(3)).toBe('3');
    expect(() => decimal(-1)).toThrow();
  });
});
