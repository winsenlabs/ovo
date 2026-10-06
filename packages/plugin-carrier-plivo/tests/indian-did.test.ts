import { describe, expect, it } from 'vitest';
import { createFakeCarrierHostPorts } from '@winsendotai/ovo-conformance';
import type { CarrierHttpRequest, ResolvedBinding } from '@winsendotai/ovo-contracts';
import { plivoE164, plivoRoutes } from '../src/routes.ts';
import { signV3 } from '../src/signature.ts';

// An Indian DID on Plivo routes by the E.164 number the operator registered (+91...). The routes
// table matches it exactly, so a callback's bare-digit number must not miss the route.

const binding: ResolvedBinding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-plivo',
  workspaceId: 'w1',
  config: { authId: 'MAINDIA0000000000000', contentType: 'audio/x-mulaw;rate=8000' },
  secret: 'plivo-test-token',
};

async function inbound(form: Record<string, string>) {
  const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
  const url = host.callbackUrl('plivo', 'b1', 'inbound');
  const nonce = 'nonce-inbound';
  const req: CarrierHttpRequest = {
    method: 'POST',
    externalUrl: url,
    query: Object.fromEntries(new URL(url).searchParams),
    headers: {
      'X-Plivo-Signature-V3': await signV3(binding.secret, url, nonce, form),
      'X-Plivo-Signature-V3-Nonce': nonce,
    },
    rawBody: new TextEncoder().encode(new URLSearchParams(form).toString()),
    bindingId: 'b1',
  };
  const route = plivoRoutes().find((item) => item.purpose === 'inbound')!;
  const reply = await route.handle(req, host);
  const admitted = host.calls.find((call) => call.method === 'admitInbound')?.args as
    { from: string; to: string } | undefined;
  return { reply, admitted };
}

describe('Plivo inbound on an Indian DID', () => {
  it('admits a bare-digit callback number under the E.164 route key', async () => {
    const { reply, admitted } = await inbound({
      CallUUID: 'c0ffee00-0000-4000-8000-000000000001',
      From: '919812345678',
      To: '918069450000',
      Direction: 'inbound',
      CallStatus: 'ringing',
    });
    expect(admitted).toMatchObject({ from: '+919812345678', to: '+918069450000' });
    expect(reply.status).toBe(200);
    // The 8 kHz mu-law stream the binding asked for: no transcode to the Scribe/ElevenLabs path.
    expect(String(reply.body)).toContain('contentType="audio/x-mulaw;rate=8000"');
    expect(String(reply.body)).toMatch(/<Stream [^>]*bidirectional="true"/);
  });

  it('keeps numbers that are already E.164, and anything that is not a number', () => {
    expect(plivoE164('+918069450000')).toBe('+918069450000');
    expect(plivoE164(' 91 80 6945-0000 ')).toBe('+918069450000');
    expect(plivoE164('sip:agent@phone.plivo.com')).toBe('sip:agent@phone.plivo.com');
    expect(plivoE164('1234')).toBe('1234');
  });
});
