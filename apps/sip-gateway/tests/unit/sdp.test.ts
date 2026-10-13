import { describe, expect, it } from 'vitest';
import {
  SdpOrigin,
  acceptAnswer,
  buildAnswer,
  buildOffer,
  negotiateOffer,
  type CodecName,
} from '../../src/sdp/negotiate.ts';
import { SdpError, directionOf, parseSdp } from '../../src/sdp/parse.ts';

function offer(media: string[], session: string[] = []): string {
  return (
    [
      'v=0',
      'o=trunk 1 1 IN IP4 198.51.100.7',
      's=-',
      'c=IN IP4 198.51.100.7',
      't=0 0',
      ...session,
      ...media,
    ].join('\r\n') + '\r\n'
  );
}

const AUDIO = (formats: string, extra: string[] = []) => [
  `m=audio 20000 RTP/AVP ${formats}`,
  'a=rtpmap:101 telephone-event/8000',
  'a=fmtp:101 0-16',
  ...extra,
];

const LOCAL = { address: '203.0.113.10', port: 40000 };

describe('SDP offer/answer matrix (RFC 3264, RFC 3551, RFC 4733)', () => {
  const cases: [string, string, CodecName[], string | { codec: CodecName; te?: number }][] = [
    ['PCMU + te', offer(AUDIO('0 101')), ['PCMU', 'PCMA'], { codec: 'PCMU', te: 101 }],
    ['PCMA only', offer(AUDIO('8 101')), ['PCMU', 'PCMA'], { codec: 'PCMA', te: 101 }],
    [
      'both, trunk prefers PCMA',
      offer(AUDIO('0 8 101')),
      ['PCMA', 'PCMU'],
      { codec: 'PCMA', te: 101 },
    ],
    ['no telephone-event', offer(['m=audio 20000 RTP/AVP 0']), ['PCMU'], { codec: 'PCMU' }],
    ['G.729 only', offer(AUDIO('18 101')), ['PCMU', 'PCMA'], 'no_codec'],
    ['PCMA offered, trunk is PCMU-only', offer(AUDIO('8')), ['PCMU'], 'no_codec'],
    ['SRTP profile', offer(['m=audio 20000 RTP/SAVP 0']), ['PCMU'], 'srtp_unsupported'],
    [
      'SDES crypto',
      offer(AUDIO('0', ['a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:x'])),
      ['PCMU'],
      'srtp_unsupported',
    ],
    ['ICE', offer(AUDIO('0', ['a=ice-ufrag:abcd'])), ['PCMU'], 'ice_unsupported'],
    ['video only', offer(['m=video 20002 RTP/AVP 96']), ['PCMU'], 'no_audio'],
    ['rejected audio', offer(['m=audio 0 RTP/AVP 0']), ['PCMU'], 'no_audio'],
    [
      'dynamic PCMU mapping',
      offer(['m=audio 20000 RTP/AVP 96', 'a=rtpmap:96 PCMU/8000']),
      ['PCMU'],
      { codec: 'PCMU' },
    ],
    [
      'wrong clock rate',
      offer(['m=audio 20000 RTP/AVP 96', 'a=rtpmap:96 PCMU/16000']),
      ['PCMU'],
      'no_codec',
    ],
  ];

  it.each(cases)('%s', (_name, text, preference, expected) => {
    const result = negotiateOffer(parseSdp(text), preference);
    if (typeof expected === 'string') expect(result).toEqual({ ok: false, reason: expected });
    else {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.choice.codec).toBe(expected.codec);
      expect(result.choice.tePt).toBe(expected.te);
      expect(result.choice.remote).toEqual({ address: '198.51.100.7', port: 20000 });
    }
  });

  it('answers one codec plus telephone-event, rejecting the other m-lines with port 0 in order', () => {
    const text = offer([
      'm=video 30000 RTP/AVP 96',
      ...AUDIO('8 0 101'),
      'm=audio 30002 RTP/AVP 0',
    ]);
    const sdp = parseSdp(text);
    const result = negotiateOffer(sdp, ['PCMU', 'PCMA']);
    if (!result.ok) throw new Error(result.reason);
    const answer = buildAnswer(sdp, result.choice, LOCAL, new SdpOrigin());
    const lines = answer.split('\r\n');
    expect(lines.filter((l) => l.startsWith('m='))).toEqual([
      'm=video 0 RTP/AVP 96',
      'm=audio 40000 RTP/AVP 0 101',
      'm=audio 0 RTP/AVP 0',
    ]);
    expect(lines).toContain('a=rtpmap:101 telephone-event/8000');
    expect(lines).toContain('a=fmtp:101 0-15');
    expect(lines).toContain('a=ptime:20');
    expect(lines).toContain('c=IN IP4 203.0.113.10');
    expect(lines).toContain('a=sendrecv');
  });

  it.each([
    ['a=sendonly', 'recvonly'],
    ['a=recvonly', 'sendonly'],
    ['a=inactive', 'inactive'],
    ['a=sendrecv', 'sendrecv'],
  ])('mirrors %s as %s', (attribute, mirrored) => {
    const result = negotiateOffer(parseSdp(offer(AUDIO('0', [attribute]))), ['PCMU']);
    expect(result.ok && result.choice.direction).toBe(mirrored);
  });

  it('treats c=0.0.0.0 as RFC 2543 hold', () => {
    const sdp = parseSdp(offer(AUDIO('0')).replace('c=IN IP4 198.51.100.7', 'c=IN IP4 0.0.0.0'));
    expect(directionOf(sdp, sdp.media[0]!)).toBe('sendonly');
  });

  it('moves o= version only when the body changes (RFC 3264 §8)', () => {
    const sdp = parseSdp(offer(AUDIO('0 101')));
    const origin = new SdpOrigin();
    const result = negotiateOffer(sdp, ['PCMU']);
    if (!result.ok) throw new Error('expected a codec');
    const version = (text: string) => Number(/^o=ovo \d+ (\d+) /m.exec(text)![1]);
    const first = buildAnswer(sdp, result.choice, LOCAL, origin);
    const same = buildAnswer(sdp, result.choice, LOCAL, origin);
    const held = buildAnswer(sdp, { ...result.choice, direction: 'recvonly' }, LOCAL, origin);
    expect(version(same)).toBe(version(first));
    expect(version(held)).toBe(version(first) + 1);
    expect(/^o=ovo (\d+) /m.exec(held)![1]).toBe(origin.id);
  });

  it('builds an offer and reads the answer to it', () => {
    const origin = new SdpOrigin();
    const ours = buildOffer(['PCMA', 'PCMU'], LOCAL, origin);
    expect(ours).toContain('m=audio 40000 RTP/AVP 8 0 101');
    const answer = offer(['m=audio 20000 RTP/AVP 0 101', 'a=rtpmap:101 telephone-event/8000']);
    const result = acceptAnswer(parseSdp(answer), ['PCMA', 'PCMU']);
    expect(result.ok && result.choice.codec).toBe('PCMU');
    expect(acceptAnswer(parseSdp(offer(['m=audio 0 RTP/AVP 0'])), ['PCMU'])).toEqual({
      ok: false,
      reason: 'no_audio',
    });
  });

  it.each([
    ['not v=0', 'v=1\r\n'],
    ['IPv6 media', offer(AUDIO('0')).replace('IN IP4 198.51.100.7\r\nt', 'IN IP6 ::1\r\nt')],
    [
      'too large',
      offer(
        AUDIO(
          '0',
          Array.from({ length: 600 }, (_, i) => `a=x-${i}:yyyyyyyyyyyyyy`),
        ),
      ),
    ],
    ['bad origin', 'v=0\r\no=x\r\n'],
    ['bad m-line', offer(['m=audio x RTP/AVP 0'])],
  ])('refuses %s', (_name, text) => {
    expect(() => parseSdp(text)).toThrow(SdpError);
  });
});
