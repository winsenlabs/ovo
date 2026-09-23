/**
 * SSRF guard (#24). Every address is parsed numerically, so no textual form (compressed IPv6,
 * embedded IPv4, mixed case) can bypass a range. Any unparseable input is treated as not public.
 */
import { ConnectorPolicyError } from './tool-errors.ts';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type HostLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const V4_BLOCKED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

/** Dotted-quad IPv4 only (no octal, hex or shorthand forms: those are rejected, not guessed). */
export function parseIpv4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** Eight 16-bit groups, or undefined. Accepts `::` compression and a trailing dotted IPv4. */
export function parseIpv6(text: string): number[] | undefined {
  let input = text.toLowerCase();
  const zone = input.indexOf('%');
  if (zone >= 0) input = input.slice(0, zone);
  let tail: number[] = [];
  const lastColon = input.lastIndexOf(':');
  if (input.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4(input.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail = [v4 >>> 16, v4 & 0xffff];
    // '::1.2.3.4' keeps its '::'; '::ffff:1.2.3.4' drops the separator colon.
    input = input.slice(0, lastColon + 1);
    if (!input.endsWith('::')) input = input.slice(0, -1);
  }
  const halves = input.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part ? part.split(':') : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const groups: number[] = [];
  for (const group of [...head, ...rest]) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
  }
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1) {
    if (explicit !== 8) return undefined;
  } else if (explicit > 7) return undefined;
  groups.push(...head.map((g) => Number.parseInt(g, 16)));
  if (halves.length === 2) for (let i = explicit; i < 8; i += 1) groups.push(0);
  groups.push(...rest.map((g) => Number.parseInt(g, 16)), ...tail);
  return groups.length === 8 ? groups : undefined;
}

function inV4(value: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === (parseIpv4(base)! & mask) >>> 0;
}

function publicV4(value: number): boolean {
  return !V4_BLOCKED.some(([base, bits]) => inV4(value, base, bits));
}

const v4Of = (high: number, low: number) => ((high << 16) >>> 0) + low;

function publicV6(g: number[]): boolean {
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::, ::1, IPv4-compatible ::a.b.c.d and IPv4-mapped ::ffff:a.b.c.d — judge the embedded IPv4.
  if (zeroPrefix(6)) {
    if (g[6] === 0 && (g[7] === 0 || g[7] === 1)) return false;
    return publicV4(v4Of(g[6]!, g[7]!));
  }
  if (zeroPrefix(5) && g[5] === 0xffff) return publicV4(v4Of(g[6]!, g[7]!));
  // IPv4-translated ::ffff:0:a.b.c.d (RFC 2765).
  if (zeroPrefix(4) && g[4] === 0xffff && g[5] === 0) return publicV4(v4Of(g[6]!, g[7]!));
  // NAT64 64:ff9b::/96 carries a public IPv4; the local-use 64:ff9b:1::/48 is never public.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return false;
    return g.slice(2, 6).every((x) => x === 0) && publicV4(v4Of(g[6]!, g[7]!));
  }
  // 6to4 2002::/16 embeds the IPv4 in groups 1-2.
  if (g[0] === 0x2002) return publicV4(v4Of(g[1]!, g[2]!));
  // Teredo 2001::/32: server IPv4 in groups 2-3, client IPv4 obfuscated (XOR) in groups 6-7.
  if (g[0] === 0x2001 && g[1] === 0) {
    return publicV4(v4Of(g[2]!, g[3]!)) && publicV4(v4Of(g[6]! ^ 0xffff, g[7]! ^ 0xffff));
  }
  const first = g[0]!;
  if (first === 0x0100 && zeroPrefix(4)) return false; // discard-only 100::/64
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return false; // site-local fec0::/10 (deprecated)
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return false; // documentation 2001:db8::/32
  if (first === 0x2001 && (g[1]! & 0xfff0) === 0x0010) return false; // ORCHID 2001:10::/28
  if (first === 0x2001 && (g[1]! & 0xfff0) === 0x0020) return false; // ORCHIDv2 2001:20::/28
  if (first === 0x2001 && g[1] === 0x0002 && g[2] === 0) return false; // benchmarking 2001:2::/48
  if ((first & 0xfff0) === 0x3ff0) return false; // documentation 3fff::/20
  // Everything outside global unicast 2000::/3 is reserved.
  return (first & 0xe000) === 0x2000;
}

/** True only for a globally routable unicast address. Brackets are accepted for IPv6. */
export function isPublicAddress(address: string): boolean {
  const text = address.replace(/^\[|\]$/g, '');
  const v4 = parseIpv4(text);
  if (v4 !== undefined) return publicV4(v4);
  if (!text.includes(':')) return false;
  const v6 = parseIpv6(text);
  return v6 ? publicV6(v6) : false;
}

export function isIpLiteral(host: string): boolean {
  const text = host.replace(/^\[|\]$/g, '');
  return parseIpv4(text) !== undefined || (text.includes(':') && parseIpv6(text) !== undefined);
}

/**
 * Rejects localhost names, private literals and any name whose DNS answer contains a non-public
 * address. Throws `ConnectorPolicyError`, because nothing has been sent yet.
 */
export async function assertPublicHost(
  host: string,
  lookup: HostLookup,
): Promise<readonly ResolvedAddress[]> {
  const hostname = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost'))
    throw new ConnectorPolicyError('Private hosts are forbidden');
  if (isIpLiteral(hostname)) {
    if (!isPublicAddress(hostname))
      throw new ConnectorPolicyError('Private or special-use address is forbidden');
    return [{ address: hostname, family: hostname.includes(':') ? 6 : 4 }];
  }
  const addresses = await lookup(hostname);
  if (addresses.length === 0) throw new ConnectorPolicyError('Host did not resolve to any address');
  if (addresses.some(({ address }) => !isPublicAddress(address)))
    throw new ConnectorPolicyError('Host DNS contains a private or special-use address');
  return addresses;
}
