import { describe, expect, it } from 'vitest';
import { formatVia, parseNameAddr, parseUri, parseVia } from '../../src/sip/address.ts';
import { SipHeaders, splitList } from '../../src/sip/message.ts';
import { SIP_LIMITS, SipParseError, frameLength, parseMessage } from '../../src/sip/parse.ts';
import { createResponse, serialize } from '../../src/sip/serialize.ts';

const INVITE = [
  'INVITE sip:+918041234567@203.0.113.10 SIP/2.0',
  'Via: SIP/2.0/UDP 198.51.100.7:5060;branch=z9hG4bK776asdhds;rport',
  'Max-Forwards: 70',
  'To: <sip:+918041234567@203.0.113.10>',
  'From: "Caller" <sip:+919876543210@198.51.100.7>;tag=1928301774',
  'Call-ID: a84b4c76e66710@pc33.example',
  'CSeq: 314159 INVITE',
  'Contact: <sip:+919876543210@198.51.100.7:5060>',
  'Content-Type: application/sdp',
  'Content-Length: 4',
  '',
  'v=0\n',
].join('\r\n');

const bytes = (text: string) => Buffer.from(text, 'latin1');

describe('SIP parser', () => {
  it('parses a request and round-trips through the serializer', () => {
    const message = parseMessage(bytes(INVITE), 'udp');
    expect(message.kind).toBe('request');
    if (message.kind !== 'request') return;
    expect(message.method).toBe('INVITE');
    expect(message.uri).toBe('sip:+918041234567@203.0.113.10');
    expect(message.headers.get('call-id')).toBe('a84b4c76e66710@pc33.example');
    expect(Buffer.from(message.body).toString()).toBe('v=0\n');
    const again = parseMessage(serialize(message), 'tcp');
    expect(again.headers.entries()).toEqual(message.headers.entries());
    expect(Buffer.from(again.body).toString()).toBe('v=0\n');
  });

  it('expands compact header forms and unfolds continuation lines', () => {
    const text = [
      'OPTIONS sip:ovo@127.0.0.1 SIP/2.0',
      'v: SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bKa',
      't: <sip:ovo@127.0.0.1>',
      'f: <sip:p@127.0.0.1>;tag=1',
      'i: c1',
      'CSeq: 1 OPTIONS',
      'Subject: first',
      '  second',
      'l: 0',
      '',
      '',
    ].join('\r\n');
    const message = parseMessage(bytes(text), 'udp');
    expect(message.headers.get('via')).toContain('branch=z9hG4bKa');
    expect(message.headers.get('call-id')).toBe('c1');
    expect(message.headers.get('subject')).toBe('first second');
  });

  it('accepts bare LF line endings', () => {
    const message = parseMessage(bytes(INVITE.replace(/\r\n/g, '\n')), 'udp');
    expect(message.headers.get('cseq')).toBe('314159 INVITE');
  });

  it('parses responses', () => {
    const text = [
      'SIP/2.0 180 Ringing',
      'Via: SIP/2.0/UDP 127.0.0.1;branch=z9hG4bKx',
      'To: <sip:a@b>;tag=9',
      'From: <sip:c@d>;tag=1',
      'Call-ID: x',
      'CSeq: 1 INVITE',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n');
    const message = parseMessage(bytes(text), 'udp');
    expect(message).toMatchObject({ kind: 'response', status: 180, reason: 'Ringing' });
  });

  it.each([
    ['no Via', INVITE.replace(/^Via:.*\r\n/m, ''), 'missing_header', false],
    [
      'bad Content-Length',
      INVITE.replace('Content-Length: 4', 'Content-Length: x'),
      'bad_content_length',
      true,
    ],
    [
      'truncated body',
      INVITE.replace('Content-Length: 4', 'Content-Length: 40'),
      'truncated_body',
      true,
    ],
    [
      'CSeq method mismatch',
      INVITE.replace('314159 INVITE', '1 BYE'),
      'cseq_method_mismatch',
      true,
    ],
    ['bad CSeq', INVITE.replace('314159 INVITE', 'x INVITE'), 'bad_cseq', true],
    ['bad start line', INVITE.replace('SIP/2.0\r\n', 'HTTP/1.1\r\n'), 'bad_start_line', false],
    [
      'bad header name',
      INVITE.replace('Max-Forwards: 70', 'Max Forwards: 70'),
      'bad_header',
      false,
    ],
  ])('refuses %s', (_name, text, reason, respondable) => {
    const error = catchParse(() => parseMessage(bytes(text), 'udp'));
    expect(error.reason).toBe(reason);
    expect(error.respondable).toBe(respondable);
  });

  it('enforces the hard limits', () => {
    const big = Buffer.alloc(SIP_LIMITS.udpBytes + 1, 0x41);
    expect(catchParse(() => parseMessage(big, 'udp')).reason).toBe('oversize');
    const many = INVITE.replace(
      'Max-Forwards: 70',
      Array.from({ length: 101 }, (_, i) => `X-H${i}: v`).join('\r\n'),
    );
    expect(catchParse(() => parseMessage(bytes(many), 'tcp')).reason).toBe('too_many_headers');
    const long = INVITE.replace('Max-Forwards: 70', `X-Long: ${'a'.repeat(SIP_LIMITS.lineBytes)}`);
    expect(catchParse(() => parseMessage(bytes(long), 'tcp')).reason).toBe('line_too_long');
    const noLength = INVITE.replace('Content-Length: 4\r\n', '');
    expect(catchParse(() => parseMessage(bytes(noLength), 'tcp')).reason).toBe(
      'missing_content_length',
    );
    // UDP without Content-Length takes the rest of the datagram (RFC 3261 §18.3).
    expect(Buffer.from(parseMessage(bytes(noLength), 'udp').body).toString()).toBe('v=0\n');
  });
});

describe('TCP framing', () => {
  it('waits for the head and the body, then frames back-to-back messages', () => {
    const one = bytes(INVITE);
    expect(frameLength(one.subarray(0, 40))).toBeUndefined();
    expect(frameLength(one.subarray(0, one.length - 1))).toBeUndefined();
    const two = Buffer.concat([one, one]);
    expect(frameLength(two)).toBe(one.length);
  });

  it('refuses a stream message without Content-Length or over 64 KiB', () => {
    expect(
      catchParse(() => frameLength(bytes(INVITE.replace('Content-Length: 4\r\n', '')))).reason,
    ).toBe('missing_content_length');
    const huge = INVITE.replace('Content-Length: 4', `Content-Length: ${70 * 1024}`);
    expect(catchParse(() => frameLength(bytes(huge))).reason).toBe('oversize');
    const endless = Buffer.alloc(SIP_LIMITS.tcpBytes + 10, 0x41);
    expect(catchParse(() => frameLength(endless)).reason).toBe('oversize');
  });
});

describe('fuzz corpus', () => {
  // A seeded generator keeps the corpus reproducible: every mutation either parses or throws a
  // SipParseError, never anything else (no TypeError, RangeError or hang).
  function* mutations(seed: number, count: number): Generator<Buffer> {
    let state = seed;
    const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff);
    const base = bytes(INVITE);
    for (let i = 0; i < count; i += 1) {
      const copy = Buffer.from(base);
      const edits = 1 + (next() % 8);
      for (let e = 0; e < edits; e += 1) copy[next() % copy.length] = next() % 256;
      const cut = next() % 4 === 0 ? copy.subarray(0, next() % copy.length) : copy;
      yield cut;
    }
  }

  it('never throws anything but SipParseError', () => {
    let parsed = 0;
    for (const sample of mutations(42, 3000))
      for (const transport of ['udp', 'tcp'] as const)
        try {
          parseMessage(sample, transport);
          parsed += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(SipParseError);
        }
    expect(parsed).toBeGreaterThan(0);
  });

  it('frames mutated streams without throwing anything but SipParseError', () => {
    for (const sample of mutations(7, 2000))
      try {
        frameLength(sample);
      } catch (error) {
        expect(error).toBeInstanceOf(SipParseError);
      }
  });
});

describe('addresses', () => {
  it('parses URIs, name-addrs and Vias', () => {
    expect(parseUri('sip:+911234@10.0.0.1:5070;transport=tcp')).toEqual({
      scheme: 'sip',
      user: '+911234',
      host: '10.0.0.1',
      port: 5070,
      params: { transport: 'tcp' },
    });
    expect(parseUri('tel:+911234')).toMatchObject({ scheme: 'tel', user: '+911234' });
    expect(parseUri('http://x')).toBeUndefined();
    expect(parseUri('sip:a@b:99999')).toBeUndefined();
    expect(parseNameAddr('"A, B" <sip:a@b;lr>;tag=x')).toEqual({
      display: 'A, B',
      uri: 'sip:a@b;lr',
      params: { tag: 'x' },
    });
    const via = parseVia('SIP/2.0/UDP 1.2.3.4:5060;branch=z9hG4bKx;rport')!;
    expect(via).toEqual({
      transport: 'UDP',
      host: '1.2.3.4',
      port: 5060,
      params: { branch: 'z9hG4bKx', rport: true },
    });
    expect(formatVia(via)).toBe('SIP/2.0/UDP 1.2.3.4:5060;branch=z9hG4bKx;rport');
  });

  it('splits header lists outside quotes and brackets', () => {
    expect(splitList('a, "b, c" <sip:d,e>, f')).toEqual(['a', '"b, c" <sip:d,e>', 'f']);
    const headers = new SipHeaders([
      ['Via', 'v1, v2'],
      ['Via', 'v3'],
    ]);
    expect(headers.getAll('via')).toEqual(['v1', 'v2', 'v3']);
    expect(headers.values('via')).toEqual(['v1, v2', 'v3']);
  });
});

describe('responses', () => {
  it('copies Via, From, To, Call-ID and CSeq and adds our tag', () => {
    const request = parseMessage(bytes(INVITE), 'udp');
    if (request.kind !== 'request') throw new Error('expected a request');
    const response = createResponse(request, 180, { toTag: 'abc' });
    expect(response.headers.get('to')).toBe('<sip:+918041234567@203.0.113.10>;tag=abc');
    expect(response.headers.getAll('via')).toEqual(request.headers.getAll('via'));
    expect(response.reason).toBe('Ringing');
    // 100 Trying never carries a To tag.
    expect(createResponse(request, 100, { toTag: 'abc' }).headers.get('to')).not.toContain('tag=');
  });
});

function catchParse(run: () => unknown): SipParseError {
  try {
    run();
  } catch (error) {
    if (error instanceof SipParseError) return error;
    throw error;
  }
  throw new Error('expected a SipParseError');
}
