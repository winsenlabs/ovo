import { lookup } from 'node:dns/promises';
import { ConnectorPolicyError, createNodeNet, type HostLookup } from '@winsendotai/ovo-plugin-kit';

export interface McpNetworkDependencies {
  lookup?: HostLookup;
  fetch?: typeof globalThis.fetch;
}
export function mcpEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConnectorPolicyError('MCP endpoint must be an absolute HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new ConnectorPolicyError(
      'MCP endpoint must use HTTPS without credentials, query, or fragment',
    );
  return url;
}
export async function mcpNetwork(endpoint: string, dependencies: McpNetworkDependencies = {}) {
  const approved = mcpEndpoint(endpoint);
  const resolve: HostLookup =
    dependencies.lookup ??
    (async (host) =>
      (await lookup(host, { all: true, verbatim: true })).map(({ address, family }) => ({
        address,
        family: family as 4 | 6,
      })));
  // A pooled client can outlive a DNS answer. Let the kit revalidate and pin each request,
  // rather than keeping the initial address set for the full lifetime of the client.
  const net = createNodeNet({
    fetch: dependencies.fetch,
    lookup: async (hostname) => {
      try {
        return await resolve(hostname);
      } catch {
        throw new ConnectorPolicyError('MCP endpoint DNS resolution failed');
      }
    },
  });

  return {
    async fetch(input: string | URL | Request, init?: RequestInit) {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.href !== approved.href)
        throw new ConnectorPolicyError(
          'MCP request destination differs from the approved endpoint',
        );
      return net.fetch(url.href, { ...init, signal: init?.signal ?? undefined, redirect: 'error' });
    },
    close: () => net.close(),
  };
}
