import type { SipHandoffTarget } from '@winsendotai/ovo-sip-carrier-kit';
import type { BridgeTarget } from '../call/bridge.ts';
import type { Trunk } from '../config/trunks.ts';
import { parseUri } from '../sip/address.ts';
import { allowedDestination } from './numbers.ts';

export type ReferTarget =
  { ok: true; referTo: string; host: string } | { ok: false; reason: string };

/** `a.b.example` is allowed by `a.b.example` (exact) and `.b.example` or `.example` (any subdomain). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase();
  return allowed.some((entry) =>
    entry.startsWith('.') ? name.endsWith(entry) && name.length > entry.length : name === entry,
  );
}

/**
 * `sip:a@evil.com@good.example` parses here with host `good.example`, but a far end that splits on
 * the first `@` routes to `evil.com`; a second `@` before the URI's parameters is never legitimate.
 */
function ambiguousUserinfo(uri: string): boolean {
  const main =
    uri
      .trim()
      .replace(/^sips?:/i, '')
      .split(/[;?]/)[0] ?? '';
  return main.split('@').length > 2;
}

/**
 * Header values are percent-encoded whole (`encodeURIComponent` leaves only RFC 3261 unreserved
 * characters), so a value can never end a header, start another or leave the URI.
 */
function withHeaders(uri: string, headers: Record<string, string> | undefined): string {
  const entries = Object.entries(headers ?? {});
  if (!entries.length) return uri;
  return `${uri}?${entries.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`;
}

/**
 * The Refer-To URI for a handoff target on `trunk`. A phone target needs the trunk's template; a
 * sip target needs its host on the trunk's allow-list (the allow-list is the only thing between a
 * third party's answer and a toll-fraud destination). `X-` names are the kit schema's job.
 */
export function referTarget(
  trunk: Trunk,
  target: SipHandoffTarget,
  countryAllowlist: readonly string[],
): ReferTarget {
  if (target.kind === 'phone') {
    // A REFER has the carrier place the call, so it answers to the same country policy as a dial.
    if (!allowedDestination(target.e164, countryAllowlist))
      return { ok: false, reason: 'destination_not_permitted' };
    const template = trunk.refer.phoneUriTemplate;
    if (!template) return { ok: false, reason: 'refer_phone_template_missing' };
    const referTo = template.replace('{e164}', target.e164);
    return { ok: true, referTo, host: parseUri(referTo)?.host ?? '' };
  }
  const uri = parseUri(target.uri);
  if (!uri || uri.scheme === 'tel' || !uri.host || ambiguousUserinfo(target.uri))
    return { ok: false, reason: 'refer_uri_invalid' };
  if (!hostAllowed(uri.host, trunk.refer.allowedHosts))
    return { ok: false, reason: 'refer_host_not_allowed' };
  return { ok: true, referTo: withHeaders(target.uri, target.headers), host: uri.host };
}

export type BridgeResolution = { ok: true; target: BridgeTarget } | { ok: false; reason: string };

/**
 * The destination of a bridged handoff (stretch S1). A phone number is dialled on the trunk's
 * outbound proxy under the same country allow-list as a worker's dial; a SIP URI needs its host on
 * the trunk's allow-list. The `X-` context rides as real INVITE headers, not URI parameters.
 */
export function bridgeTarget(
  trunk: Trunk,
  target: SipHandoffTarget,
  countryAllowlist: readonly string[],
): BridgeResolution {
  if (target.kind === 'phone')
    return allowedDestination(target.e164, countryAllowlist)
      ? { ok: true, target: { to: target.e164, headers: [] } }
      : { ok: false, reason: 'destination_not_permitted' };
  const uri = parseUri(target.uri);
  if (!uri || uri.scheme === 'tel' || !uri.host || ambiguousUserinfo(target.uri))
    return { ok: false, reason: 'refer_uri_invalid' };
  if (!hostAllowed(uri.host, trunk.refer.allowedHosts))
    return { ok: false, reason: 'refer_host_not_allowed' };
  return {
    ok: true,
    target: {
      to: uri.user ?? '',
      requestUri: target.uri,
      headers: Object.entries(target.headers ?? {}),
    },
  };
}
