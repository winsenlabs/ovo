import type { DestinationPolicy, WebhookDestination } from './human-contract.ts';

export type DestinationRefusal =
  'ambiguous' | 'malformed' | 'e164_prefix' | 'sip_scheme' | 'sip_host' | 'none';
export type CheckedDestination =
  { kind: 'phone'; e164: string } | { kind: 'sip'; uri: string; headers: Record<string, string> };

const E164 = /^\+[1-9][0-9]{5,14}$/;
const SIP_URI = /^(sips?):([^@\s;?]+@)?([A-Za-z0-9.-]+)(:\d{1,5})?(;[^?\s]*)?$/;
const HEADER_VALUE = /^[\x20-\x7e]{1,256}$/;

/**
 * Toll-fraud guard (design 11): a third party's answer reaches only what the queue allows. A phone
 * number needs an allowed prefix; a SIP URI needs `sips:` (unless relaxed) and an allowed host;
 * header names outside the allow-list, and values that are not short printable ASCII, are dropped.
 */
export function checkDestination(
  policy: DestinationPolicy,
  destination: WebhookDestination,
): { ok: true; target: CheckedDestination } | { ok: false; reason: DestinationRefusal } {
  const { e164, sipUri } = destination;
  if (e164 && sipUri) return { ok: false, reason: 'ambiguous' };
  if (e164) {
    if (!E164.test(e164)) return { ok: false, reason: 'malformed' };
    return policy.allowE164Prefixes.some((prefix) => e164.startsWith(prefix))
      ? { ok: true, target: { kind: 'phone', e164 } }
      : { ok: false, reason: 'e164_prefix' };
  }
  if (!sipUri) return { ok: false, reason: 'none' };
  const match = SIP_URI.exec(sipUri);
  if (!match) return { ok: false, reason: 'malformed' };
  const host = match[3]!.toLowerCase();
  if (match[1] === 'sip' && !policy.allowInsecureSip) return { ok: false, reason: 'sip_scheme' };
  const hostAllowed = policy.allowSipHosts.some((allowed) =>
    allowed.startsWith('.') ? host.endsWith(allowed) : host === allowed,
  );
  if (!hostAllowed) return { ok: false, reason: 'sip_host' };
  // Header names take the policy's own spelling; anything it does not list is dropped.
  const allowed = new Map(policy.allowedHeaders.map((name) => [name.toLowerCase(), name]));
  const headers = Object.fromEntries(
    Object.entries(destination.headers ?? {}).flatMap(([name, value]) => {
      const canonical = allowed.get(name.toLowerCase());
      return canonical && HEADER_VALUE.test(value) ? [[canonical, value]] : [];
    }),
  );
  return {
    ok: true,
    target: {
      kind: 'sip',
      uri: `${match[1]}:${match[2] ?? ''}${host}${match[4] ?? ''}${match[5] ?? ''}`,
      headers,
    },
  };
}
