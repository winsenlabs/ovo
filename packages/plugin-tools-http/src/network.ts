import { lookup as dnsLookup } from 'node:dns/promises';
import {
  assertPublicHost,
  createNodeNet,
  isIpLiteral,
  isPublicAddress,
  ConnectorPolicyError,
  ToolInvocationError,
} from '@winsendotai/ovo-plugin-kit';
export { isPublicAddress } from '@winsendotai/ovo-plugin-kit';
import { limitResponseBody, validateResponseByteLimit } from './response-limit.ts';

export interface NetworkAddress {
  address: string;
  family: 4 | 6;
}

export interface SecureNetworkDependencies {
  lookup?: (hostname: string) => Promise<readonly NetworkAddress[]>;
  /** Test/host injection only. The default fetch is DNS-pinned with Undici. */
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
}

export interface PinnedFetch {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function parseApprovedEndpoint(
  endpoint: string,
  options: { allowQuery?: boolean } = {},
): URL {
  const url = new URL(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:') throw new ConnectorPolicyError('Tool endpoints must use HTTPS');
  if (url.username || url.password)
    throw new ConnectorPolicyError('Tool endpoints cannot contain URL credentials');
  if (url.hash) throw new ConnectorPolicyError('Tool endpoints cannot contain fragments');
  if (options.allowQuery === false && url.search)
    throw new ConnectorPolicyError('Tool endpoint query parameters are forbidden');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new ConnectorPolicyError('Private tool endpoints are forbidden');
  }
  if (isIpLiteral(hostname) && !isPublicAddress(hostname)) {
    throw new ConnectorPolicyError('Private or special-use tool endpoint is forbidden');
  }
  return url;
}

function sameApprovedDestination(actual: URL, approved: URL): boolean {
  return (
    actual.protocol === approved.protocol &&
    actual.hostname === approved.hostname &&
    actual.port === approved.port &&
    actual.pathname === approved.pathname &&
    actual.username === '' &&
    actual.password === '' &&
    actual.hash === ''
  );
}

export async function createPinnedFetch(
  endpoint: string,
  dependencies: SecureNetworkDependencies = {},
): Promise<PinnedFetch> {
  const approved = parseApprovedEndpoint(endpoint);
  const maxResponseBytes = validateResponseByteLimit(dependencies.maxResponseBytes);
  const hostname = approved.hostname.replace(/^\[|\]$/g, '');
  const resolve =
    dependencies.lookup ??
    (async (name: string) => {
      const records = await dnsLookup(name, { all: true, verbatim: true });
      return records.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
    });
  const addresses = await assertPublicHost(hostname, resolve).catch((cause: unknown) => {
    if (cause instanceof ConnectorPolicyError) throw cause;
    throw new ConnectorPolicyError('Tool endpoint DNS resolution failed');
  });
  const net = createNodeNet({ lookup: async () => addresses, fetch: dependencies.fetch });

  return {
    async fetch(input, init = {}) {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (!sameApprovedDestination(url, approved)) {
        throw new ConnectorPolicyError('Request destination is not the operator-approved endpoint');
      }
      const response = await net.fetch(url.toString(), {
        ...init,
        signal: init.signal ?? undefined,
        redirect: 'manual',
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        throw new ToolInvocationError('Tool endpoint redirects are forbidden', 'not-applied');
      }
      return limitResponseBody(response, maxResponseBytes);
    },
    async dispose() {
      await net.close();
    },
  };
}
