import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SIP_HEADERS,
  canonicalUrl,
  createSipRequestVerifier,
  decodeSipSecret,
  signRequest,
} from '../src/index.ts';

const key = new Uint8Array(32).fill(7);
const previous = new Uint8Array(32).fill(9);
const T0 = 1_760_000_000_000;
const url = 'https://ovo.example.test/carriers/sip/b1/inbound';
const body = new TextEncoder().encode('{"v":1}');
const nonce = 'AAAAAAAAAAAAAAAAAAAAAA';

const sign = (overrides: Partial<Parameters<typeof signRequest>[0]> = {}) =>
  signRequest({ key, method: 'POST', externalUrl: url, body, now: T0, nonce, ...overrides });
const verifier = (keys = [key], now = () => T0, extra = {}) =>
  createSipRequestVerifier({ keys, now, ...extra });
const verify = (
  v: ReturnType<typeof verifier>,
  headers: Record<string, string>,
  overrides: Partial<Parameters<ReturnType<typeof verifier>['verify']>[0]> = {},
) => v.verify({ method: 'POST', externalUrl: url, headers, body, ...overrides });

describe('ovo-sip/1 request signing (§5.1)', () => {
  it('signs the documented canonical string with HMAC-SHA256', async () => {
    const headers = await sign();
    const canonical = [
      'v1',
      'POST',
      url,
      String(T0),
      nonce,
      createHash('sha256').update(body).digest('hex'),
    ].join('\n');
    expect(headers).toEqual({
      [SIP_HEADERS.version]: '1',
      [SIP_HEADERS.timestamp]: String(T0),
      [SIP_HEADERS.nonce]: nonce,
      [SIP_HEADERS.signature]: `v1=${createHmac('sha256', key).update(canonical).digest('base64url')}`,
    });
  });

  it('mints a fresh 16-byte base64url nonce per request', async () => {
    const a = await signRequest({ key, method: 'GET', externalUrl: url, body: new Uint8Array() });
    const b = await signRequest({ key, method: 'GET', externalUrl: url, body: new Uint8Array() });
    expect(a[SIP_HEADERS.nonce]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a[SIP_HEADERS.nonce]).not.toBe(b[SIP_HEADERS.nonce]);
  });

  it('verifies a valid request and ignores header case and the url-secret query', async () => {
    const headers = Object.fromEntries(
      Object.entries(await sign()).map(([name, value]) => [name.toUpperCase(), value]),
    );
    expect(await verify(verifier(), headers, { externalUrl: `${url}?r=dial-1&t=secret` })).toBe(
      true,
    );
  });

  it('refuses a timestamp outside ±30 s, inclusive bound accepted', async () => {
    expect(await verify(verifier(), await sign({ now: T0 - 30_000 }))).toBe(true);
    expect(await verify(verifier(), await sign({ now: T0 + 30_000 }))).toBe(true);
    expect(await verify(verifier(), await sign({ now: T0 - 30_001 }))).toBe(false);
    expect(await verify(verifier(), await sign({ now: T0 + 30_001 }))).toBe(false);
  });

  it('accepts each nonce once within its TTL', async () => {
    let now = T0;
    const v = verifier([key], () => now);
    const headers = await sign();
    expect(await verify(v, headers)).toBe(true);
    expect(await verify(v, headers)).toBe(false);
    now = T0 + 59_999;
    expect(await verify(v, await sign({ now }))).toBe(false);
    now = T0 + 60_001;
    expect(await verify(v, await sign({ now }))).toBe(true);
  });

  it('admits only one of two concurrent deliveries of one nonce', async () => {
    const v = verifier();
    const headers = await sign();
    const results = await Promise.all([verify(v, headers), verify(v, headers)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('fails closed when the nonce cache is full of live nonces', async () => {
    const v = verifier([key], () => T0, { maxNonces: 2 });
    const nonces = ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCCCC'];
    const results = [];
    for (const n of nonces) results.push(await verify(v, await sign({ nonce: n })));
    expect(results).toEqual([true, true, false]);
  });

  it('does not record a nonce whose signature failed', async () => {
    const v = verifier();
    const forged = await sign({ key: previous });
    expect(await verify(v, forged)).toBe(false);
    expect(await verify(v, await sign())).toBe(true);
  });

  it('rotates keys: the previous secret verifies only while listed', async () => {
    const old = await sign({ key: previous });
    expect(await verify(verifier([key, previous]), old)).toBe(true);
    expect(await verify(verifier([key]), old)).toBe(false);
  });

  it('refuses a wrong path, method, body or origin', async () => {
    const headers = await sign();
    expect(
      await verify(verifier(), headers, { externalUrl: url.replace('inbound', 'status') }),
    ).toBe(false);
    expect(await verify(verifier(), headers, { method: 'GET' })).toBe(false);
    expect(await verify(verifier(), headers, { body: new TextEncoder().encode('{"v":2}') })).toBe(
      false,
    );
    expect(
      await verify(verifier(), headers, {
        externalUrl: url.replace('ovo.example', 'evil.example'),
      }),
    ).toBe(false);
  });

  it.each([
    ['missing version', { [SIP_HEADERS.version]: undefined }],
    ['version 2', { [SIP_HEADERS.version]: '2' }],
    ['non-decimal timestamp', { [SIP_HEADERS.timestamp]: '1e12' }],
    ['short nonce', { [SIP_HEADERS.nonce]: 'AAAA' }],
    ['unversioned signature', { [SIP_HEADERS.signature]: 'deadbeef' }],
    ['missing signature', { [SIP_HEADERS.signature]: undefined }],
  ])('refuses %s', async (_label, patch) => {
    const headers: Record<string, string | undefined> = { ...(await sign()), ...patch };
    expect(await verifier().verify({ method: 'POST', externalUrl: url, headers, body })).toBe(
      false,
    );
  });
});

describe('canonicalUrl and secrets', () => {
  it('keeps the public origin and explicit port, drops any query', () => {
    expect(canonicalUrl('https://ovo.example.test', '/carriers/sip/b1/media', 'wss')).toBe(
      'wss://ovo.example.test/carriers/sip/b1/media',
    );
    expect(
      canonicalUrl(
        'https://ovo.example.test:8443/ignored',
        '/carriers/sip/b1/status?r=1&t=2',
        'https',
      ),
    ).toBe('https://ovo.example.test:8443/carriers/sip/b1/status');
  });

  it('refuses a non-https base and a non-relative path', () => {
    expect(() => canonicalUrl('http://ovo.example.test', '/x', 'https')).toThrow(/https/);
    expect(() => canonicalUrl('https://ovo.example.test', '//evil/x', 'https')).toThrow();
  });

  it('decodes base64 and base64url secrets of at least 32 bytes', () => {
    const raw = new Uint8Array(32).map((_, i) => 250 - i);
    expect(decodeSipSecret(Buffer.from(raw).toString('base64'))).toEqual(raw);
    expect(decodeSipSecret(Buffer.from(raw).toString('base64url'))).toEqual(raw);
    expect(() => decodeSipSecret(Buffer.alloc(31).toString('base64'))).toThrow(/32 bytes/);
    expect(() => decodeSipSecret('not base64!')).toThrow(/base64/);
  });

  it('refuses to build a verifier without keys', () => {
    expect(() => createSipRequestVerifier({ keys: [] })).toThrow();
  });
});
