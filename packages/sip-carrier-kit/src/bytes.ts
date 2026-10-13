/** Byte helpers on web globals only: kits may not import node built-ins. */

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** Canonical standard base64 only; anything `btoa` would not produce is refused. */
export function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError('Invalid base64');
  }
  if (btoa(binary) !== value) throw new TypeError('Non-canonical base64');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return decodeBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return undefined;
  }
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** A copy backed by a plain ArrayBuffer, which is what WebCrypto's BufferSource accepts. */
export function bufferOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}
