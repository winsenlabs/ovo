import { describe, expect, it } from 'vitest';
import { parseTrunkFile } from '../../src/config/trunks.ts';
import { hostAllowed, referTarget } from '../../src/policy/refer-target.ts';
import { loopbackTrunk } from '../support/harness.ts';

const trunk = (refer: Record<string, unknown>) =>
  parseTrunkFile({ version: 1, trunks: [loopbackTrunk({ refer })] })[0]!;
const ENABLED = trunk({
  enabled: true,
  phoneUriTemplate: 'sip:{e164}@sbc.example.net;user=phone',
  allowedHosts: ['.acd.example.net', 'transfer.example.net', '203.0.113.7'],
});

describe('hostAllowed', () => {
  it.each([
    ['transfer.example.net', true],
    ['TRANSFER.example.net', true],
    ['a.acd.example.net', true],
    ['x.y.acd.example.net', true],
    ['203.0.113.7', true],
    ['acd.example.net', false],
    ['evilacd.example.net', false],
    ['acd.example.net.evil.com', false],
    ['xtransfer.example.net', false],
    ['203.0.113.70', false],
    ['', false],
  ])('%j is %s', (host, allowed) =>
    expect(hostAllowed(host, ENABLED.refer.allowedHosts)).toBe(allowed),
  );

  it('allows nothing from an empty list', () => expect(hostAllowed('a.example', [])).toBe(false));
});

describe('referTarget', () => {
  it('builds a phone Refer-To from the template', () => {
    expect(referTarget(ENABLED, { kind: 'phone', e164: '+919000000042' })).toEqual({
      ok: true,
      referTo: 'sip:+919000000042@sbc.example.net;user=phone',
      host: 'sbc.example.net',
    });
  });

  it('refuses a phone target without a template', () => {
    expect(
      referTarget(trunk({ enabled: true, allowedHosts: ['a.example'] }), {
        kind: 'phone',
        e164: '+919000000042',
      }),
    ).toEqual({ ok: false, reason: 'refer_phone_template_missing' });
  });

  it('encodes every header value so none can add a header or leave the URI', () => {
    const result = referTarget(ENABLED, {
      kind: 'sip',
      uri: 'sips:desk@q.acd.example.net:5061;transport=tls',
      headers: { 'X-A': 'v1&X-Evil=1', 'X-B': '>; <sip:evil@x>', 'X-C': 'ok value' },
    });
    expect(result).toMatchObject({ ok: true, host: 'q.acd.example.net' });
    const referTo = (result as { referTo: string }).referTo;
    expect(referTo).toBe(
      'sips:desk@q.acd.example.net:5061;transport=tls?X-A=v1%26X-Evil%3D1&X-B=%3E%3B%20%3Csip%3Aevil%40x%3E&X-C=ok%20value',
    );
    expect(referTo.split('?')).toHaveLength(2);
    expect(referTo).not.toMatch(/[<> ]/);
  });

  it('a sip target without headers is passed through bare', () => {
    expect(referTarget(ENABLED, { kind: 'sip', uri: 'sip:desk@transfer.example.net' })).toEqual({
      ok: true,
      referTo: 'sip:desk@transfer.example.net',
      host: 'transfer.example.net',
    });
  });

  it.each([
    ['sips:x@evil.example.com', 'refer_host_not_allowed'],
    ['sip:x@acd.example.net', 'refer_host_not_allowed'],
    ['sip:x@transfer.example.net.evil.com', 'refer_host_not_allowed'],
    ['sip:@@', 'refer_uri_invalid'],
    ['sip:', 'refer_uri_invalid'],
  ])('refuses %j as %s', (uri, reason) =>
    expect(referTarget(ENABLED, { kind: 'sip', uri })).toEqual({ ok: false, reason }),
  );
});
