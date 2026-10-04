const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(value: string): string {
  let bits = 0;
  let buffer = 0;
  let result = '';
  for (const byte of new TextEncoder().encode(value)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(buffer >>> (bits -= 5)) & 31];
    }
  }
  if (bits) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

function fromBase32(value: string): string {
  if (!/^[A-Z2-7]+$/.test(value)) throw new Error('Invalid Plivo extraHeaders value');
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const char of value) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) bytes.push((buffer >>> (bits -= 8)) & 255);
  }
  if (bits && (buffer & ((1 << bits) - 1)) !== 0)
    throw new Error('Invalid Plivo extraHeaders padding bits');
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
}

/** Stream XML reference uses comma-separated key=value pairs, at most 512 bytes. */
export function encodeExtraHeaders(params: Record<string, string>): string {
  const value = Object.entries(params)
    .map(([key, raw]) => {
      if (!/^[A-Za-z0-9]+$/.test(key) || !raw)
        throw new Error('Plivo extraHeaders keys must be alphanumeric and values nonempty');
      return `${key}=${base32(raw)}`;
    })
    .join(',');
  if (new TextEncoder().encode(value).byteLength > 512)
    throw new Error('Plivo extraHeaders exceed 512 bytes');
  return value;
}

export function decodeExtraHeaders(
  value: string | Record<string, unknown>,
): Record<string, string> {
  const raw =
    typeof value === 'string'
      ? Object.fromEntries(value.split(/[,;]/).map((pair) => pair.split('=')))
      : value;
  const result: Record<string, string> = {};
  for (const key of ['sid', 'rt']) {
    const encoded = raw[key];
    if (typeof encoded === 'string' && encoded) result[key] = fromBase32(encoded);
  }
  return result;
}
