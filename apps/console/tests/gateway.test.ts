import { describe, expect, it, vi } from 'vitest';
import { proxyManagementRequest, upstreamUrl } from '../lib/gateway';

describe('management API gateway', () => {
  it('maps same-origin API paths to the server-only management API', () => {
    expect(upstreamUrl('http://localhost:3000/api/v1/agents?limit=10', ['agents']).toString()).toBe(
      'http://127.0.0.1:4000/v1/agents?limit=10',
    );
  });

  it('forwards HttpOnly cookies without adding an admin token', async () => {
    const fetcher = vi.fn(async (_url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toBe('ovo_session=opaque');
      expect(headers.get('authorization')).toBeNull();
      return Response.json(
        { ok: true },
        { headers: { 'set-cookie': 'ovo_session=renewed; HttpOnly; SameSite=Strict' } },
      );
    });
    const response = await proxyManagementRequest(
      new Request('http://localhost:3000/api/v1/auth/me', {
        headers: { cookie: 'ovo_session=opaque' },
      }),
      ['auth', 'me'],
      fetcher as typeof fetch,
    );
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns a bounded unavailable error instead of leaking upstream details', async () => {
    const response = await proxyManagementRequest(
      new Request('http://localhost:3000/api/v1/agents'),
      ['agents'],
      vi.fn(async () => {
        throw new Error('secret host details');
      }) as typeof fetch,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'api_unavailable', message: 'The management API is unavailable.' },
    });
  });

  it('streams authenticated WAV responses without converting them to JSON', async () => {
    const wav = new Uint8Array([82, 73, 70, 70]);
    const response = await proxyManagementRequest(
      new Request('http://localhost:3000/api/v1/calls/call-1/recordings/rec-1/audio', {
        headers: { cookie: 'ovo_session=opaque' },
      }),
      ['calls', 'call-1', 'recordings', 'rec-1', 'audio'],
      vi.fn(async (_url: URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('cookie')).toBe('ovo_session=opaque');
        return new Response(wav, { headers: { 'content-type': 'audio/wav' } });
      }) as typeof fetch,
    );
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(wav);
  });
});
