import type { ResolvedBinding, UpgradeRequest } from '@winsendotai/ovo-contracts';

const utf8 = new TextEncoder();

export function basicAuthorization(apiKey: string, token: string): string {
  const bytes = utf8.encode(`${apiKey}:${token}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  let difference = a.byteLength ^ b.byteLength;
  for (let i = 0; i < Math.max(a.byteLength, b.byteLength); i++)
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function ipv4(value: string): number[] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  return octets;
}

function ipv6(value: string): number[] | undefined {
  let address = value.toLowerCase();
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const tail = ipv4(address.slice(lastColon + 1));
    if (!tail) return undefined;
    address = `${address.slice(0, lastColon + 1)}${((tail[0]! << 8) | tail[1]!).toString(16)}:${((tail[2]! << 8) | tail[3]!).toString(16)}`;
  }
  if (address.split('::').length > 2) return undefined;
  const [before, after] = address.split('::');
  const first = before ? before.split(':') : [];
  const last = after ? after.split(':') : [];
  if ([...first, ...last].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  const missing = 8 - first.length - last.length;
  if (missing < (address.includes('::') ? 1 : 0) || (!address.includes('::') && missing !== 0))
    return undefined;
  const words = [...first, ...Array(missing).fill('0'), ...last].map((part) => parseInt(part, 16));
  if (words.length !== 8) return undefined;
  return words.flatMap((word) => [word >> 8, word & 255]);
}

function addressBytes(value: string): number[] | undefined {
  return ipv4(value) ?? ipv6(value.replace(/^\[|\]$/g, ''));
}

/** Fail closed on invalid addresses and CIDR masks, including malformed forwarded hops. */
export function inCidr(address: string, cidr: string): boolean {
  const [network, bitsText, extra] = cidr.split('/');
  if (!network || extra !== undefined) return false;
  const source = addressBytes(address);
  const target = addressBytes(network);
  if (!source || !target || source.length !== target.length) return false;
  const bits = bitsText === undefined ? source.length * 8 : Number(bitsText);
  if (!/^(0|[1-9]\d*)$/.test(bitsText ?? String(bits)) || bits > source.length * 8) return false;
  let difference = 0;
  for (let i = 0; i < source.length; i++) {
    const remaining = bits - i * 8;
    const mask = remaining >= 8 ? 255 : remaining <= 0 ? 0 : (255 << (8 - remaining)) & 255;
    difference |= (source[i]! ^ target[i]!) & mask;
  }
  return difference === 0;
}

export function allowedAddress(req: UpgradeRequest, binding: ResolvedBinding): boolean {
  const cidrs = binding.config.allowedCidrs;
  if (cidrs === undefined) return true;
  if (!Array.isArray(cidrs) || !cidrs.length || cidrs.some((cidr) => typeof cidr !== 'string'))
    return false;
  const forwarded = header(req.headers, 'x-forwarded-for');
  const address = (forwarded?.split(',')[0] ?? req.remoteAddress)?.trim();
  return !!address && cidrs.some((cidr) => inCidr(address, cidr));
}

export function validBasic(req: UpgradeRequest, binding: ResolvedBinding): boolean {
  const apiKey = binding.config.apiKey;
  if (typeof apiKey !== 'string' || !apiKey || !binding.secret) return false;
  const given = header(req.headers, 'authorization');
  return (
    typeof given === 'string' &&
    constantTimeEqual(given, basicAuthorization(apiKey, binding.secret))
  );
}
