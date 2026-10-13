import { createHash, randomBytes } from 'node:crypto';

/**
 * UAC digest authentication (RFC 3261 §22, RFC 2617, RFC 7616 / RFC 8760 SHA-256). Only `qop=auth`
 * (or no qop) is answered; `auth-int` and `-sess` variants are refused.
 */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  algorithm: 'MD5' | 'SHA-256';
  qop?: 'auth';
  stale: boolean;
}

/** Splits `Digest a="x, y", b=z` into its parameters. */
export function parseAuthParams(text: string): Record<string, string> | undefined {
  const match = /^\s*Digest\s+(.*)$/is.exec(text);
  if (!match) return undefined;
  const params: Record<string, string> = {};
  for (const m of match[1]!.matchAll(/([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g))
    params[m[1]!.toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]!;
  return params;
}

export function parseChallenge(header: string): DigestChallenge | undefined {
  const params = parseAuthParams(header);
  if (!params?.realm || !params.nonce) return undefined;
  const algorithm = (params.algorithm ?? 'MD5').toUpperCase();
  if (algorithm !== 'MD5' && algorithm !== 'SHA-256') return undefined;
  const qops = params.qop?.split(',').map((q) => q.trim().toLowerCase());
  if (qops && !qops.includes('auth')) return undefined;
  return {
    realm: params.realm,
    nonce: params.nonce,
    ...(params.opaque !== undefined ? { opaque: params.opaque } : {}),
    algorithm,
    ...(qops ? { qop: 'auth' as const } : {}),
    stale: params.stale?.toLowerCase() === 'true',
  };
}

/** Among several challenges, SHA-256 is preferred; MD5 remains for backward compatibility. */
export function pickChallenge(headers: readonly string[]): DigestChallenge | undefined {
  const parsed = headers.map(parseChallenge).filter((c): c is DigestChallenge => !!c);
  return parsed.find((c) => c.algorithm === 'SHA-256') ?? parsed[0];
}

const hash = (algorithm: DigestChallenge['algorithm'], value: string) =>
  createHash(algorithm === 'MD5' ? 'md5' : 'sha256')
    .update(value, 'utf8')
    .digest('hex');

export function digestResponse(input: {
  challenge: DigestChallenge;
  username: string;
  password: string;
  method: string;
  uri: string;
  cnonce: string;
  nc: number;
}): string {
  const { challenge: c } = input;
  const ha1 = hash(c.algorithm, `${input.username}:${c.realm}:${input.password}`);
  const ha2 = hash(c.algorithm, `${input.method}:${input.uri}`);
  if (!c.qop) return hash(c.algorithm, `${ha1}:${c.nonce}:${ha2}`);
  const nc = input.nc.toString(16).padStart(8, '0');
  return hash(c.algorithm, `${ha1}:${c.nonce}:${nc}:${input.cnonce}:${c.qop}:${ha2}`);
}

const quote = (value: string) => `"${value.replace(/(["\\])/g, '\\$1')}"`;

/** The Authorization / Proxy-Authorization value for one request. */
export function authorization(input: {
  challenge: DigestChallenge;
  username: string;
  password: string;
  method: string;
  uri: string;
  nc?: number;
  cnonce?: string;
}): string {
  const nc = input.nc ?? 1;
  const cnonce = input.cnonce ?? randomBytes(12).toString('hex');
  const c = input.challenge;
  const response = digestResponse({ ...input, cnonce, nc });
  const parts = [
    `username=${quote(input.username)}`,
    `realm=${quote(c.realm)}`,
    `nonce=${quote(c.nonce)}`,
    `uri=${quote(input.uri)}`,
    `response=${quote(response)}`,
    `algorithm=${c.algorithm}`,
    ...(c.opaque !== undefined ? [`opaque=${quote(c.opaque)}`] : []),
    ...(c.qop
      ? [`qop=${c.qop}`, `nc=${nc.toString(16).padStart(8, '0')}`, `cnonce=${quote(cnonce)}`]
      : []),
  ];
  return `Digest ${parts.join(', ')}`;
}
