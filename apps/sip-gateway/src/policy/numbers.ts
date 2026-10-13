import { parseNameAddr, parseUri } from '../sip/address.ts';

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * A trunk's number as E.164 (§4.7). `IN`: `+91XXXXXXXXXX`, `91XXXXXXXXXX`, `0XXXXXXXXXX` and a
 * bare 10-digit national number all become `+91XXXXXXXXXX`; anything else is undefined (→ 404).
 * The forms real trunks send are UNCONFIRMED until onboarding captures them.
 */
export function normaliseNumber(raw: string, country: 'IN' | 'E164'): string | undefined {
  const cleaned = raw.trim().replace(/[\s().-]/g, '');
  if (country === 'E164') return E164.test(cleaned) ? cleaned : undefined;
  let national: string | undefined;
  if (/^\+91\d{10}$/.test(cleaned)) national = cleaned.slice(3);
  else if (/^91\d{10}$/.test(cleaned)) national = cleaned.slice(2);
  else if (/^0\d{10}$/.test(cleaned)) national = cleaned.slice(1);
  else if (/^\d{10}$/.test(cleaned)) national = cleaned;
  // National significant numbers never start with 0.
  return national && /^[1-9]/.test(national) ? `+91${national}` : undefined;
}

/** The user part of a sip:/tel: URI (or name-addr), without visual separators. */
export function userOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const uri = parseNameAddr(value)?.uri ?? value;
  return parseUri(uri)?.user?.split(';')[0];
}

/** Whether `to` is E.164 under one of the allowed country prefixes (outbound policy). */
export function allowedDestination(to: string, prefixes: readonly string[]): boolean {
  return E164.test(to) && prefixes.some((prefix) => to.startsWith(prefix));
}
