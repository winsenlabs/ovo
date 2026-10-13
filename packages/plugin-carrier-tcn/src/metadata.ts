import type { CarrierHostPorts, InboundAdmission } from '@winsendotai/ovo-contracts';

/** At most this many headers per binding; the sip-gateway forwards at most 16 per trunk. */
export const TCN_MAX_METADATA_HEADERS = 16;
const SIP_HEADER = 'sip.header.';

/** `X-TCN-Call-Sid` → `tcn.x-tcn-call-sid`: the raw key agent variables read (W11 §8). */
export function tcnMetadataKey(name: string): string {
  return `tcn.${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`;
}

/**
 * Adds a `tcn.*` key for each forwarded header the binding allow-lists in `metadataHeaders`
 * (names compared case-insensitively). Every other header keeps only the `sip.header.*` key the
 * sip-gateway's trunk `forwardHeaders` already allowed.
 */
export function withTcnMetadata(
  raw: Readonly<Record<string, string>> | undefined,
  allowed: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = { ...raw };
  const wanted = new Set(allowed.map((name) => name.toLowerCase()));
  if (!wanted.size) return out;
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!key.startsWith(SIP_HEADER)) continue;
    const name = key.slice(SIP_HEADER.length);
    if (wanted.has(name.toLowerCase())) out[tcnMetadataKey(name)] = value;
  }
  return out;
}

export function metadataHeadersOf(config: Readonly<Record<string, unknown>>): string[] {
  const headers = config.metadataHeaders;
  return Array.isArray(headers)
    ? headers.filter((name): name is string => typeof name === 'string')
    : [];
}

/**
 * The host ports the kit's inbound route sees: every port delegates to the gateway's, except that
 * an admission gains the binding's `tcn.*` metadata keys before the host decides on it.
 */
export function tcnHostPorts(host: CarrierHostPorts): CarrierHostPorts {
  return {
    resolveBinding: (bindingId) => host.resolveBinding(bindingId),
    async admitInbound(admission: InboundAdmission) {
      const binding = await host.resolveBinding(admission.bindingId);
      return host.admitInbound({
        ...admission,
        raw: withTcnMetadata(admission.raw, metadataHeadersOf(binding.config)),
      });
    },
    confirmCallback: (admission) => host.confirmCallback(admission),
    applyCallEvent: (event) => host.applyCallEvent(event),
    streamForDial: (query) => host.streamForDial(query),
    resumeStream: (query) => host.resumeStream(query),
    mediaUrl: (carrierId, bindingId, opts) => host.mediaUrl(carrierId, bindingId, opts),
    callbackUrl: (carrierId, bindingId, purpose, opts) =>
      host.callbackUrl(carrierId, bindingId, purpose, opts),
    verifyUrlSecret: (req, opts) => host.verifyUrlSecret(req, opts),
  };
}
