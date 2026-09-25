import type { CarrierHttpRequest } from '@winsendotai/ovo-contracts';

export function header(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? headers[key] : undefined;
}

export function formParams(body: Uint8Array): Record<string, string> {
  const params = new URLSearchParams(new TextDecoder().decode(body));
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) throw new Error('Duplicate Plivo form parameter');
    result[key] = value;
  }
  return result;
}

/** Mirrors Plivo's documented SDK construction without normalizing percent escapes or ports. */
export function signatureInput(
  url: string,
  nonce: string,
  params: Record<string, string> = {},
  method: 'GET' | 'POST' = 'POST',
): string {
  const match = /^(https?:\/\/[^/?#]+[^?#]*|wss:\/\/[^/?#]+[^?#]*)(?:\?([^#]*))?$/.exec(url);
  if (!match) throw new Error('Plivo signed URL must be absolute without a fragment');
  const query = new Map<string, string[]>();
  for (const part of (match[2] ?? '').split('&').filter(Boolean)) {
    const index = part.indexOf('=');
    if (index < 0) throw new Error('Plivo signed URL query is malformed');
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    query.set(key, [...(query.get(key) ?? []), value]);
  }
  if (method === 'GET')
    for (const [key, value] of Object.entries(params))
      query.set(key, [...(query.get(key) ?? []), value]);
  const queryString = [...query.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([key, values]) => values.sort().map((value) => `${key}=${value}`))
    .join('&');
  let constructed = match[1]!;
  if (queryString || (method === 'POST' && Object.keys(params).length))
    constructed += `?${queryString}`;
  if (method === 'POST' && queryString && Object.keys(params).length) constructed += '.';
  if (method === 'POST')
    constructed += Object.entries(params)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => key + value)
      .join('');
  return `${constructed}.${nonce}`;
}

export async function signV3(
  token: string,
  url: string,
  nonce: string,
  params: Record<string, string> = {},
  method: 'GET' | 'POST' = 'POST',
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signatureInput(url, nonce, params, method)),
  );
  return Buffer.from(signed).toString('base64');
}

/** A fixed-length byte loop avoids timing differences from early mismatch. */
function equalSignature(expected: string, candidate: string): boolean {
  const bytes = Buffer.from(candidate, 'base64');
  const reference = Buffer.from(expected, 'base64');
  let mismatch = bytes.byteLength ^ reference.byteLength;
  for (let i = 0; i < reference.byteLength; i++) mismatch |= reference[i]! ^ (bytes[i] ?? 0);
  return (
    mismatch === 0 && candidate.replace(/=+$/, '') === bytes.toString('base64').replace(/=+$/, '')
  );
}

export async function verifyV3(input: {
  token: string;
  url: string;
  headers: Readonly<Record<string, string | undefined>>;
  params?: Record<string, string>;
  method?: 'GET' | 'POST';
}): Promise<boolean> {
  const nonce = header(input.headers, 'X-Plivo-Signature-V3-Nonce');
  const signatures = [
    header(input.headers, 'X-Plivo-Signature-V3'),
    header(input.headers, 'X-Plivo-Signature-Ma-V3'),
  ].filter((value): value is string => !!value);
  if (!nonce || !signatures.length) return false;
  const expected = await signV3(input.token, input.url, nonce, input.params, input.method);
  return signatures.some((group) =>
    group.split(',').some((candidate) => equalSignature(expected, candidate.trim())),
  );
}

export async function verifyHttpV3(req: CarrierHttpRequest, token: string): Promise<boolean> {
  return verifyV3({
    token,
    url: req.externalUrl,
    headers: req.headers,
    params: req.method === 'POST' ? formParams(req.rawBody) : {},
    method: req.method,
  });
}
