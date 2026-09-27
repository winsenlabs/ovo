/** Twilio signs the externally visible URL followed by sorted POST name/value pairs. */
function sha1(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const padded = new Uint8Array((Math.ceil((input.length + 9) / 64) || 1) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  for (let block = 0; block < padded.length; block += 64) {
    const words = new Int32Array(80);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 80; i++) {
      const value = words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!;
      words[i] = (value << 1) | (value >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      const f =
        i < 20 ? (b & c) | (~b & d) : i < 40 || i >= 60 ? b ^ c ^ d : (b & c) | (b & d) | (c & d);
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const value = (((a << 5) | (a >>> 27)) + f + e + k + words[i]!) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = value;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const result = new Uint8Array(20);
  const output = new DataView(result.buffer);
  [h0, h1, h2, h3, h4].forEach((value, index) => output.setUint32(index * 4, value));
  return result;
}

function hmacSha1(token: string, message: string): Uint8Array {
  const encoder = new TextEncoder();
  const inputKey = encoder.encode(token);
  const key = inputKey.length > 64 ? sha1(inputKey) : inputKey;
  const inner = new Uint8Array(64 + encoder.encode(message).length);
  const outer = new Uint8Array(84);
  const encoded = encoder.encode(message);
  for (let i = 0; i < 64; i++) {
    inner[i] = (key[i] ?? 0) ^ 0x36;
    outer[i] = (key[i] ?? 0) ^ 0x5c;
  }
  inner.set(encoded, 64);
  outer.set(sha1(inner), 64);
  return sha1(outer);
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(input: Uint8Array): string {
  let result = '';
  for (let i = 0; i < input.length; i += 3) {
    const value = (input[i]! << 16) | ((input[i + 1] ?? 0) << 8) | (input[i + 2] ?? 0);
    result += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63];
    result += i + 1 < input.length ? alphabet[(value >>> 6) & 63] : '=';
    result += i + 2 < input.length ? alphabet[value & 63] : '=';
  }
  return result;
}

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string> = {},
): string {
  const sorted = Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = url + sorted.map((key) => key + params[key]).join('');
  return base64(hmacSha1(authToken, payload));
}

/** Match node:querystring's decode/group/encode behavior without a Node dependency. */
function legacyQueryUrl(value: string): string {
  const url = new URL(value);
  if (!url.search) return value;
  const grouped: Record<string, string[]> = Object.create(null);
  // The reference querystring.parse defaults to at most 1,000 pairs.
  const pairs = url.search.slice(1).split('&').slice(0, 1000).join('&');
  for (const [key, entry] of new URLSearchParams(pairs)) (grouped[key] ??= []).push(entry);
  const query = Object.keys(grouped)
    .flatMap((key) =>
      grouped[key]!.map((entry) => `${encodeURIComponent(key)}=${encodeURIComponent(entry)}`),
    )
    .join('&');
  url.search = '';
  return `${url.href}?${query}`;
}

/** Twilio 5.10.4 accepts four HTTPS forms because its backend signing is inconsistent.
 * WSS retains the exact URL, with its separate trailing-slash retry in the serializer.
 */
function signatureUrls(value: string): string[] {
  if (value.startsWith('wss://')) return [value];
  const url = new URL(value);
  const withPort = url.port ? url.href : url.href.replace(/^(https:\/\/[^/?#]+)/, '$1:443');
  url.port = '';
  const withoutPort = url.href;
  return [withoutPort, withPort, legacyQueryUrl(withoutPort), legacyQueryUrl(withPort)];
}

/** Fixed-length byte comparison even when the presented signature is malformed. */
export function validateTwilioSignature(input: {
  authToken: string;
  signature: string | undefined;
  externalUrl: string;
  parameters?: Record<string, string>;
}): boolean {
  if (!/^https:\/\//.test(input.externalUrl) && !/^wss:\/\//.test(input.externalUrl)) return false;
  return signatureUrls(input.externalUrl).some((url) => {
    const expected = twilioSignature(input.authToken, url, input.parameters);
    const actual = input.signature ?? '';
    let diff = expected.length ^ actual.length;
    for (let i = 0; i < expected.length; i++)
      diff |= expected.charCodeAt(i) ^ (actual.charCodeAt(i) || 0);
    return diff === 0;
  });
}
