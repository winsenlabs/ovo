import { randomInt } from 'node:crypto';
import { directionOf, type Direction, type Sdp } from './parse.ts';

export type CodecName = 'PCMU' | 'PCMA';
export const STATIC_PT: Readonly<Record<CodecName, number>> = { PCMU: 0, PCMA: 8 };
/** Our dynamic payload type for telephone-event in offers we make. */
export const OFFER_TE_PT = 101;
export const PTIME_MS = 20;

/** The negotiated media of a dialog. */
export interface MediaChoice {
  codec: CodecName;
  /** The payload type the remote side uses for the codec. */
  pt: number;
  /** telephone-event payload type, when both sides support RFC 4733. */
  tePt?: number;
  remote: { address: string; port: number };
  /** What we send in our SDP for this stream. */
  direction: Direction;
  /** The index of the audio m-line in the offer. */
  index: number;
}

export type Negotiation = { ok: true; choice: MediaChoice } | { ok: false; reason: string };

const MIRROR: Readonly<Record<Direction, Direction>> = {
  sendrecv: 'sendrecv',
  sendonly: 'recvonly',
  recvonly: 'sendonly',
  inactive: 'inactive',
};

function codecIn(
  rtpmap: Map<string, { name: string; rate: number }>,
  formats: readonly string[],
  name: string,
): number | undefined {
  const pt = formats.find((f) => {
    const map = rtpmap.get(f);
    return map?.name === name && map.rate === 8000;
  });
  return pt === undefined ? undefined : Number(pt);
}

/**
 * RFC 3264 §6: the first acceptable `m=audio RTP/AVP` stream with a codec from `preference`
 * (trunk order). SRTP, ICE, IPv6 or no common codec is a 488 reason.
 */
export function negotiateOffer(offer: Sdp, preference: readonly CodecName[]): Negotiation {
  if (offer.ice || offer.media.some((m) => m.ice)) return { ok: false, reason: 'ice_unsupported' };
  let reason = 'no_audio';
  for (const [index, media] of offer.media.entries()) {
    if (media.media !== 'audio' || media.port === 0) continue;
    if (media.proto !== 'RTP/AVP' || media.crypto) {
      reason = 'srtp_unsupported';
      continue;
    }
    const address = media.connection ?? offer.connection;
    if (!address) {
      reason = 'no_connection';
      continue;
    }
    for (const codec of preference) {
      const pt = codecIn(media.rtpmap, media.formats, codec);
      if (pt === undefined) continue;
      const te = codecIn(media.rtpmap, media.formats, 'TELEPHONE-EVENT');
      return {
        ok: true,
        choice: {
          codec,
          pt,
          ...(te !== undefined ? { tePt: te } : {}),
          remote: { address, port: media.port },
          direction: MIRROR[directionOf(offer, media)],
          index,
        },
      };
    }
    reason = 'no_codec';
  }
  return { ok: false, reason };
}

/** Our side of the media: one RTP port and the advertised address. */
export interface LocalMedia {
  address: string;
  port: number;
}

/** `o=` session id and version (RFC 3264 §8): the version moves only when the body changes. */
export class SdpOrigin {
  readonly id = String(randomInt(1, 2 ** 31));
  private version = randomInt(1, 2 ** 20);
  private last?: string;

  render(address: string, rest: string): string {
    if (this.last !== undefined && this.last !== rest) this.version += 1;
    this.last = rest;
    return `v=0\r\no=ovo ${this.id} ${this.version} IN IP4 ${address}\r\ns=ovo\r\n${rest}`;
  }
}

function audioLines(
  local: LocalMedia,
  codecs: [CodecName, number][],
  te: number | undefined,
  direction: Direction,
) {
  const pts = [...codecs.map(([, pt]) => pt), ...(te !== undefined ? [te] : [])];
  return [
    `m=audio ${local.port} RTP/AVP ${pts.join(' ')}`,
    ...codecs.map(([name, pt]) => `a=rtpmap:${pt} ${name}/8000`),
    ...(te !== undefined ? [`a=rtpmap:${te} telephone-event/8000`, `a=fmtp:${te} 0-15`] : []),
    `a=ptime:${PTIME_MS}`,
    `a=${direction}`,
  ];
}

/** The answer: one codec (plus telephone-event when offered); every other m-line rejected with port 0. */
export function buildAnswer(
  offer: Sdp,
  choice: MediaChoice,
  local: LocalMedia,
  origin: SdpOrigin,
): string {
  const lines = [`c=IN IP4 ${local.address}`, 't=0 0'];
  for (const [index, media] of offer.media.entries()) {
    if (index === choice.index)
      lines.push(...audioLines(local, [[choice.codec, choice.pt]], choice.tePt, choice.direction));
    else lines.push(`m=${media.media} 0 ${media.proto} ${media.formats[0] ?? '0'}`);
  }
  return origin.render(local.address, `${lines.join('\r\n')}\r\n`);
}

/** Our offer for an outbound INVITE (or a session refresh): trunk codecs in order, then te. */
export function buildOffer(
  codecs: readonly CodecName[],
  local: LocalMedia,
  origin: SdpOrigin,
  direction: Direction = 'sendrecv',
): string {
  const lines = [
    `c=IN IP4 ${local.address}`,
    't=0 0',
    ...audioLines(
      local,
      codecs.map((c) => [c, STATIC_PT[c]]),
      OFFER_TE_PT,
      direction,
    ),
  ];
  return origin.render(local.address, `${lines.join('\r\n')}\r\n`);
}

/** Reads the remote answer to our offer: the first offered codec the answer kept. */
export function acceptAnswer(answer: Sdp, offered: readonly CodecName[]): Negotiation {
  const index = answer.media.findIndex((m) => m.media === 'audio');
  const media = answer.media[index];
  if (!media || media.port === 0 || media.proto !== 'RTP/AVP')
    return { ok: false, reason: 'no_audio' };
  const address = media.connection ?? answer.connection;
  if (!address) return { ok: false, reason: 'no_connection' };
  for (const pt of media.formats) {
    const name = media.rtpmap.get(pt)?.name;
    const codec = offered.find((c) => c === name);
    if (!codec) continue;
    const te = codecIn(media.rtpmap, media.formats, 'TELEPHONE-EVENT');
    return {
      ok: true,
      choice: {
        codec,
        pt: Number(pt),
        ...(te !== undefined ? { tePt: te } : {}),
        remote: { address, port: media.port },
        direction: MIRROR[directionOf(answer, media)],
        index,
      },
    };
  }
  return { ok: false, reason: 'no_codec' };
}
