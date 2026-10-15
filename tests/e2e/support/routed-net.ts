import type { NetPort } from '../../../packages/contracts/src/index.ts';
import { loopbackNetOptions } from '../../../packages/conformance/src/drivers/loopback-server.ts';

type CreateNodeNet = (options?: ReturnType<typeof loopbackNetOptions>) => NetPort & {
  close(): Promise<void>;
};

/**
 * Replaces the production `ovo.net` factory for the live-path test. Each provider host is sent to
 * its loopback TLS fake through the real `createNodeNet` (address guard and TLS verification
 * stay on); any other host is refused, so nothing in the call can reach the internet.
 */
export function routedNodeNet(actual: CreateNodeNet, routes: ReadonlyMap<string, string>) {
  return () => {
    const base = actual(loopbackNetOptions());
    const target = (raw: string, protocol: 'https:' | 'wss:') => {
      const url = new URL(raw);
      const origin = routes.get(url.host);
      if (!origin) throw new Error(`live-path test has no fake for ${url.host}`);
      const routed = new URL(`${url.pathname}${url.search}`, origin);
      routed.protocol = protocol;
      return routed.href;
    };
    return {
      fetch: (url: string, init?: Parameters<NetPort['fetch']>[1]) =>
        base.fetch(target(url, 'https:'), init),
      websocket: (url: string, options?: Parameters<NetPort['websocket']>[1]) =>
        base.websocket(target(url, 'wss:'), options),
      close: () => base.close(),
    };
  };
}

type Lookup = (hostname: string, options: { all: true; verbatim?: boolean }) => Promise<unknown[]>;

/** A public address that is not routable from the test: the policy check sees a public host. */
const PUBLIC_ADDRESS = '93.184.216.34';

/**
 * `node:dns/promises` `lookup` for the live-path tests that reach a third-party host through the
 * pinned fetch (the webhook of a human queue). The address policy still runs: a routed host
 * resolves to a public address, so a policy test with a private one fails closed; the TLS
 * connection itself goes to the fake through `routedNodeNet`. Any other host resolves for real.
 */
export function routedLookup(actual: Lookup, routes: ReadonlyMap<string, string>): Lookup {
  return async (hostname, options) =>
    routes.has(hostname) ? [{ address: PUBLIC_ADDRESS, family: 4 }] : actual(hostname, options);
}
