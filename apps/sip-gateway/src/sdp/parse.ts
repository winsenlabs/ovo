/** A strict reader for the SDP the trunk profile needs (RFC 4566 subset, RFC 3264). */

export type Direction = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
const DIRECTIONS = new Set<string>(['sendrecv', 'sendonly', 'recvonly', 'inactive']);

export const SDP_LIMITS = Object.freeze({ bytes: 8192, media: 16, formats: 64, lines: 256 });

export interface SdpMedia {
  media: string;
  port: number;
  proto: string;
  formats: string[];
  connection?: string;
  /** payload type → `{ name, rate }` from a=rtpmap (static types filled from RFC 3551). */
  rtpmap: Map<string, { name: string; rate: number }>;
  fmtp: Map<string, string>;
  ptime?: number;
  direction?: Direction;
  /** ICE or SDES-SRTP attributes, which this profile refuses. */
  ice: boolean;
  crypto: boolean;
}

export interface Sdp {
  origin: { username: string; sessionId: string; version: string; address: string };
  connection?: string;
  direction?: Direction;
  ice: boolean;
  media: SdpMedia[];
}

export class SdpError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SdpError';
  }
}

const STATIC: Readonly<Record<string, { name: string; rate: number }>> = {
  '0': { name: 'PCMU', rate: 8000 },
  '8': { name: 'PCMA', rate: 8000 },
  '18': { name: 'G729', rate: 8000 },
  '9': { name: 'G722', rate: 8000 },
};

function connectionOf(value: string): string {
  const match = /^IN (IP4|IP6) ([^\s/]+)/.exec(value);
  if (!match) throw new SdpError('bad_connection');
  // IPv6 media is outside the profile: the trunks and the VM are IPv4.
  if (match[1] !== 'IP4') throw new SdpError('ipv6_unsupported');
  return match[2]!;
}

export function parseSdp(body: Uint8Array | string): Sdp {
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  if (Buffer.byteLength(text) > SDP_LIMITS.bytes) throw new SdpError('sdp_too_large');
  const lines = text.split(/\r?\n/).filter((line) => line.length);
  if (lines.length > SDP_LIMITS.lines) throw new SdpError('sdp_too_large');
  if (lines[0] !== 'v=0') throw new SdpError('bad_version');
  const sdp: Partial<Sdp> & { media: SdpMedia[]; ice: boolean } = { media: [], ice: false };
  let current: SdpMedia | undefined;
  for (const line of lines.slice(1)) {
    const type = line[0];
    const value = line.slice(2);
    if (line[1] !== '=') throw new SdpError('bad_line');
    if (type === 'o') {
      const parts = value.split(' ');
      if (parts.length !== 6) throw new SdpError('bad_origin');
      sdp.origin = {
        username: parts[0]!,
        sessionId: parts[1]!,
        version: parts[2]!,
        address: parts[5]!,
      };
    } else if (type === 'c') {
      const address = connectionOf(value);
      if (current) current.connection = address;
      else sdp.connection = address;
    } else if (type === 'm') {
      const match = /^(\w+) (\d{1,5})(?:\/\d+)? (\S+)((?: \S+)*)$/.exec(value);
      if (!match) throw new SdpError('bad_media');
      const formats = match[4]!.trim().split(' ').filter(Boolean);
      if (formats.length > SDP_LIMITS.formats) throw new SdpError('too_many_formats');
      if (sdp.media.length >= SDP_LIMITS.media) throw new SdpError('too_many_media');
      const rtpmap = new Map<string, { name: string; rate: number }>();
      for (const pt of formats) if (STATIC[pt]) rtpmap.set(pt, STATIC[pt]!);
      current = {
        media: match[1]!,
        port: Number(match[2]),
        proto: match[3]!,
        formats,
        rtpmap,
        fmtp: new Map(),
        ice: false,
        crypto: false,
      };
      sdp.media.push(current);
    } else if (type === 'a') attribute(value, sdp, current);
  }
  if (!sdp.origin) throw new SdpError('bad_origin');
  return sdp as Sdp;
}

function attribute(value: string, sdp: { direction?: Direction; ice: boolean }, media?: SdpMedia) {
  const colon = value.indexOf(':');
  const name = colon < 0 ? value : value.slice(0, colon);
  const rest = colon < 0 ? '' : value.slice(colon + 1);
  if (DIRECTIONS.has(name)) {
    if (media) media.direction = name as Direction;
    else sdp.direction = name as Direction;
    return;
  }
  if (name.startsWith('ice-') || name === 'candidate') {
    if (media) media.ice = true;
    else sdp.ice = true;
    return;
  }
  if (!media) return;
  if (name === 'crypto' || name === 'fingerprint') media.crypto = true;
  else if (name === 'rtpmap') {
    const match = /^(\d{1,3}) ([^/\s]+)\/(\d+)/.exec(rest);
    if (match)
      media.rtpmap.set(match[1]!, { name: match[2]!.toUpperCase(), rate: Number(match[3]) });
  } else if (name === 'fmtp') {
    const match = /^(\d{1,3}) (.*)$/.exec(rest);
    if (match) media.fmtp.set(match[1]!, match[2]!.trim());
  } else if (name === 'ptime') {
    const ptime = Number(rest);
    if (Number.isInteger(ptime) && ptime > 0 && ptime <= 1000) media.ptime = ptime;
  }
}

/** The effective direction of a stream: media level, then session level, then sendrecv. */
export function directionOf(sdp: Sdp, media: SdpMedia): Direction {
  const address = media.connection ?? sdp.connection;
  // RFC 2543-style hold (c=0.0.0.0) means the offerer will not receive.
  if (address === '0.0.0.0') return media.direction === 'inactive' ? 'inactive' : 'sendonly';
  return media.direction ?? sdp.direction ?? 'sendrecv';
}
