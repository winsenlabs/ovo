import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CAPABILITY_SPECS,
  Cap,
  capabilitySpec,
  isCapKey,
  type CapabilityMap,
  type SipRequestVerifier,
  type SipTrunkControlClient,
} from '../src/index.ts';

describe('SIP trunk host capabilities (W11 §5.5)', () => {
  it('spells the two keys exactly once, in contracts', () => {
    expect(Cap.sipTrunkControl).toBe('ovo.sip-trunk.control');
    expect(Cap.sipTrunkVerifier).toBe('ovo.sip-trunk.verifier');
    expect(isCapKey('ovo.sip-trunk.control')).toBe(true);
    expect(isCapKey('ovo.sip-trunk.verifier')).toBe(true);
  });

  it('declares both as process-scoped with cardinality one', () => {
    for (const key of [Cap.sipTrunkControl, Cap.sipTrunkVerifier]) {
      expect(CAPABILITY_SPECS[key]).toEqual({ major: 1, cardinality: 'one', scope: 'process' });
      expect(capabilitySpec(key).cardinality).toBe('one');
    }
  });

  it('types the capability map entries', () => {
    expectTypeOf<CapabilityMap['ovo.sip-trunk.control']>().toEqualTypeOf<SipTrunkControlClient>();
    expectTypeOf<CapabilityMap['ovo.sip-trunk.verifier']>().toEqualTypeOf<SipRequestVerifier>();
  });

  it('keeps the port shapes implementable as written', async () => {
    const seen: unknown[] = [];
    const client: SipTrunkControlClient = {
      async request(input) {
        seen.push(input);
        return { status: 200, body: { kind: 'pending' } };
      },
    };
    const verifier: SipRequestVerifier = {
      async verify({ method, externalUrl, headers, body }) {
        return (
          method === 'POST' &&
          externalUrl.startsWith('https://') &&
          headers['x-ovo-sip-version'] === '1' &&
          body.byteLength > 0
        );
      },
    };
    await expect(
      client.request({ method: 'GET', path: '/v1/calls', query: { requestId: 'r-1' } }),
    ).resolves.toEqual({ status: 200, body: { kind: 'pending' } });
    expect(seen).toEqual([{ method: 'GET', path: '/v1/calls', query: { requestId: 'r-1' } }]);
    await expect(
      verifier.verify({
        method: 'POST',
        externalUrl: 'https://ovo.example.test/carriers/sip/b1/inbound',
        headers: { 'x-ovo-sip-version': '1' },
        body: new Uint8Array([123, 125]),
      }),
    ).resolves.toBe(true);
  });
});
