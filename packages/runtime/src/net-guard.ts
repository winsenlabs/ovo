import type { ManifestV2, NetPort } from '@winsendotai/ovo-contracts';
import type { ViolationKind } from './enforcement.ts';

type Report = (kind: ViolationKind, key: string, message?: string) => void;

/** Exact host match, or `*.example.com` for any subdomain (never the apex). Case-insensitive. */
export function hostAllowed(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
  });
}

/**
 * The plugin's view of the host network (§3.3): https for fetch, wss for websockets, and only the
 * hosts in `runtime.egressHosts`. Anything else is an `egress-denied` violation, which always throws.
 */
export function filteredNet(
  hostNet: () => NetPort | undefined,
  manifest: ManifestV2,
  report: Report,
): NetPort {
  const allowed = manifest.runtime?.egressHosts ?? [];
  const admit = (url: string, protocol: 'https:' | 'wss:'): NetPort => {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    const host = parsed?.hostname ?? url;
    if (!parsed || parsed.protocol !== protocol || !hostAllowed(parsed.hostname, allowed))
      report(
        'egress-denied',
        host,
        `egress-denied: ${manifest.id} may not reach ${parsed ? `${parsed.protocol}//${host}` : 'an invalid URL'}`,
      );
    const net = hostNet();
    if (!net) throw new Error(`${manifest.id}: ovo.net is not available in this composition`);
    return net;
  };
  return Object.freeze({
    fetch: async (url: string, init?: RequestInit & { signal?: AbortSignal }) =>
      admit(url, 'https:').fetch(url, init),
    websocket: (url: string, opts?: { headers?: Record<string, string>; protocols?: string[] }) =>
      admit(url, 'wss:').websocket(url, opts),
  });
}
