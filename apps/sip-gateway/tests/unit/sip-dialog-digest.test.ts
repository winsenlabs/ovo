import { describe, expect, it } from 'vitest';
import { finalToState, q850Cause, retryAfterSeconds } from '../../src/sip/cause.ts';
import { Dialog } from '../../src/sip/dialog.ts';
import {
  authorization,
  digestResponse,
  parseAuthParams,
  parseChallenge,
  pickChallenge,
} from '../../src/sip/digest.ts';
import { SipHeaders, type SipRequest, type SipResponse } from '../../src/sip/message.ts';
import { SessionTimer, parseSessionExpires, uasSessionTimer } from '../../src/sip/session-timer.ts';
import { FakeClock } from '../support/fake-clock.ts';

function invite(extra: [string, string][] = []): SipRequest {
  const headers = new SipHeaders()
    .append('via', 'SIP/2.0/UDP 198.51.100.7;branch=z9hG4bKa')
    .append('record-route', '<sip:p1.example;lr>')
    .append('record-route', '<sip:p2.example;lr>')
    .append('from', '<sip:+919876543210@198.51.100.7>;tag=remote')
    .append('to', '<sip:+918041234567@203.0.113.10>')
    .append('call-id', 'c1')
    .append('cseq', '10 INVITE')
    .append('contact', '<sip:caller@198.51.100.7:5062>');
  for (const [name, value] of extra) headers.append(name, value);
  return {
    kind: 'request',
    method: 'INVITE',
    uri: 'sip:+918041234567@203.0.113.10',
    headers,
    body: new Uint8Array(),
  };
}

describe('dialogs (RFC 3261 §12)', () => {
  it('builds the UAS dialog with the Record-Route set in order and a growing remote CSeq', () => {
    const dialog = Dialog.asUas(invite(), 'local');
    expect(dialog.remoteTarget).toBe('sip:caller@198.51.100.7:5062');
    const bye = dialog.request('BYE');
    expect(bye.uri).toBe('sip:caller@198.51.100.7:5062');
    expect(bye.headers.getAll('route')).toEqual(['<sip:p1.example;lr>', '<sip:p2.example;lr>']);
    expect(bye.headers.get('from')).toContain('tag=local');
    expect(bye.headers.get('to')).toContain('tag=remote');
    expect(dialog.route().nextHop.uri).toBe('sip:p1.example;lr');
    const reinvite = invite();
    reinvite.headers.set('cseq', '11 INVITE');
    reinvite.headers.set('to', '<sip:x@y>;tag=local');
    expect(dialog.matches(reinvite)).toBe(true);
    expect(dialog.acceptRemoteSeq(reinvite)).toBe(true);
    expect(dialog.acceptRemoteSeq(reinvite)).toBe(false);
  });

  it('builds the UAC dialog with the route set reversed and ACKs with the INVITE CSeq', () => {
    const headers = new SipHeaders()
      .append('record-route', '<sip:p2.example;lr>')
      .append('record-route', '<sip:p1.example;lr>')
      .append('to', '<sip:+918041234567@203.0.113.10>;tag=uas')
      .append('contact', '<sip:uas@203.0.113.10:5070;transport=tcp>');
    const response: SipResponse = {
      kind: 'response',
      status: 200,
      reason: 'OK',
      headers,
      body: new Uint8Array(),
    };
    const ours = invite();
    ours.headers.set('from', '<sip:+918000000000@ovo>;tag=ours');
    const dialog = Dialog.asUac(ours, response);
    const ack = dialog.ack(10);
    expect(ack.headers.get('cseq')).toBe('10 ACK');
    expect(ack.headers.getAll('route')).toEqual(['<sip:p1.example;lr>', '<sip:p2.example;lr>']);
    expect(dialog.request('BYE').headers.get('cseq')).toBe('11 BYE');
  });

  it('honours a strict-routing first hop', () => {
    const strict = invite();
    strict.headers.delete('record-route');
    strict.headers.append('record-route', '<sip:strict.example>');
    const dialog = Dialog.asUas(strict, 'l');
    const { uri, routes, nextHop } = dialog.route();
    expect(uri).toBe('sip:strict.example');
    expect(routes).toEqual(['<sip:caller@198.51.100.7:5062>']);
    expect(nextHop.uri).toBe('sip:strict.example');
  });
});

describe('digest (RFC 2617, RFC 7616 / RFC 8760)', () => {
  it('matches the RFC 2617 §3.5 MD5 vector', () => {
    const challenge = parseChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    )!;
    expect(
      digestResponse({
        challenge,
        username: 'Mufasa',
        password: 'Circle Of Life',
        method: 'GET',
        uri: '/dir/index.html',
        cnonce: '0a4f113b',
        nc: 1,
      }),
    ).toBe('6629fae49393a05397450978507c4ef1');
  });

  it('matches the RFC 7616 §3.9.1 SHA-256 and MD5 vectors', () => {
    const base =
      'realm="http-auth@example.org", qop="auth, auth-int", nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"';
    const input = {
      username: 'Mufasa',
      password: 'Circle of Life',
      method: 'GET',
      uri: '/dir/index.html',
      cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
      nc: 1,
    };
    const sha = parseChallenge(`Digest ${base}, algorithm=SHA-256`)!;
    expect(digestResponse({ challenge: sha, ...input })).toBe(
      '753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1',
    );
    const md5 = parseChallenge(`Digest ${base}, algorithm=MD5`)!;
    expect(digestResponse({ challenge: md5, ...input })).toBe('8ca523f5e9506fed4657c9700eebdbec');
  });

  it('prefers SHA-256, refuses auth-int-only and -sess challenges, and formats the header', () => {
    const md5 = 'Digest realm="r", nonce="n1"';
    const sha = 'Digest realm="r", nonce="n2", algorithm=SHA-256, qop="auth"';
    expect(pickChallenge([md5, sha])?.algorithm).toBe('SHA-256');
    expect(parseChallenge('Digest realm="r", nonce="n", qop="auth-int"')).toBeUndefined();
    expect(parseChallenge('Digest realm="r", nonce="n", algorithm=MD5-sess')).toBeUndefined();
    expect(parseChallenge('Basic realm="r"')).toBeUndefined();
    expect(parseChallenge('Digest realm="r", nonce="n", stale=TRUE')?.stale).toBe(true);
    const header = authorization({
      challenge: parseChallenge(sha)!,
      username: 'u"1',
      password: 'p',
      method: 'INVITE',
      uri: 'sip:+911234567890@203.0.113.20',
      cnonce: 'abc',
    });
    const params = parseAuthParams(header)!;
    expect(params).toMatchObject({
      username: 'u"1',
      realm: 'r',
      nonce: 'n2',
      qop: 'auth',
      nc: '00000001',
      cnonce: 'abc',
    });
    expect(params.response).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('session timers (RFC 4028)', () => {
  it('parses Session-Expires and decides as UAS', () => {
    expect(parseSessionExpires('90;refresher=uac')).toEqual({ seconds: 90, refresher: 'uac' });
    expect(parseSessionExpires('x')).toBeUndefined();
    expect(uasSessionTimer(invite())).toEqual({ kind: 'none' });
    expect(uasSessionTimer(invite([['Session-Expires', '60']]))).toEqual({
      kind: 'reject',
      minSe: 90,
    });
    expect(
      uasSessionTimer(
        invite([
          ['Session-Expires', '100'],
          ['Min-SE', '120'],
        ]),
      ),
    ).toEqual({
      kind: 'reject',
      minSe: 120,
    });
    expect(
      uasSessionTimer(
        invite([
          ['Session-Expires', '90;refresher=uac'],
          ['Supported', 'timer'],
        ]),
      ),
    ).toEqual({
      kind: 'timer',
      seconds: 90,
      refresher: 'uac',
      headers: [
        ['Session-Expires', '90;refresher=uac'],
        ['Require', 'timer'],
      ],
    });
    // A UAC without timer support cannot refresh, so we do.
    expect(uasSessionTimer(invite([['Session-Expires', '1800']]))).toMatchObject({
      refresher: 'uas',
    });
  });

  it('refreshes at SE/2 as refresher and expires at SE − min(32, SE/3) otherwise', () => {
    const clock = new FakeClock(0);
    const events: string[] = [];
    const timer = new SessionTimer(clock, {
      refresh: () => events.push(`refresh@${clock.now()}`),
      expire: () => events.push(`expire@${clock.now()}`),
    });
    timer.arm(1800, true);
    clock.advance(900_000);
    timer.arm(90, false);
    clock.advance(100_000);
    expect(events).toEqual(['refresh@900000', 'expire@960000']);
    timer.arm(90, false);
    timer.stop();
    clock.advance(100_000);
    expect(events).toHaveLength(2);
  });
});

describe('SIP final → CallState (§5.4)', () => {
  it.each([
    [200, undefined, 'in_progress', false],
    [486, undefined, 'busy', false],
    [600, undefined, 'busy', false],
    [408, undefined, 'no_answer', false],
    [480, undefined, 'no_answer', false],
    [487, 'ring-timeout', 'no_answer', false],
    [487, 'host', 'canceled', false],
    [404, undefined, 'failed', false],
    [403, undefined, 'failed', false],
    [484, undefined, 'failed', false],
    [603, undefined, 'failed', false],
    [604, undefined, 'failed', false],
    [503, undefined, 'failed', true],
    [500, undefined, 'failed', true],
  ] as const)('%i (%s) → %s', (status, by, state, retryable) => {
    expect(finalToState(status, by)).toEqual({ state, retryable });
  });

  it('reads Q.850 causes and Retry-After', () => {
    expect(q850Cause('Q.850;cause=16;text="Normal call clearing"')).toBe(16);
    expect(q850Cause('SIP;cause=200')).toBeUndefined();
    expect(retryAfterSeconds('30 (maintenance);duration=60')).toBe(30);
    expect(retryAfterSeconds(undefined)).toBeUndefined();
  });
});
