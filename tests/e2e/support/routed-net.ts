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
