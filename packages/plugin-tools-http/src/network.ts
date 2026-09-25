import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
// undici's own fetch, not globalThis.fetch: Node 22's global fetch rejects an undici@8 dispatcher
// with "invalid onRequestStart method", which silently disabled this pinned path in production.
import { Agent, fetch as undiciFetch } from 'undici';
import { ExecutionPolicyError, ToolInvocationError } from '@winsendotai/ovo-plugin-tools';
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

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
}

function inV4Range(value: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (ipv4Number(base) & mask);
}

export function isPublicAddress(address: string): boolean {
  address = address.replace(/^\[|\]$/g, '');
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return ![
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4Range(value, base as string, bits as number));
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    return isPublicAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
  }
  if (normalized === '::' || normalized === '::1') return false;
  if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff'))
    return false;
  if (normalized.startsWith('64:ff9b:')) return false;
  return !(normalized.startsWith('2001:db8:') || normalized === '2001:db8::');
}

export function parseApprovedEndpoint(
  endpoint: string,
  options: { allowQuery?: boolean } = {},
): URL {
  const url = new URL(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:') throw new ExecutionPolicyError('Tool endpoints must use HTTPS');
  if (url.username || url.password)
    throw new ExecutionPolicyError('Tool endpoints cannot contain URL credentials');
  if (url.hash) throw new ExecutionPolicyError('Tool endpoints cannot contain fragments');
  if (options.allowQuery === false && url.search)
    throw new ExecutionPolicyError('Tool endpoint query parameters are forbidden');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new ExecutionPolicyError('Private tool endpoints are forbidden');
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new ExecutionPolicyError('Private or special-use tool endpoint is forbidden');
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
  const addresses = await resolve(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new ExecutionPolicyError('Tool endpoint DNS contains a private or special-use address');
  }

  let agent: Agent | undefined;
  let fetchImpl = dependencies.fetch;
  if (!fetchImpl) {
    const pinned = addresses.map(({ address, family }) => ({ address, family }));
    const lookup: LookupFunction = (_hostname, options, callback) => {
      const eligible = options.family
        ? pinned.filter(({ family }) => family === options.family)
        : pinned;
      if (eligible.length === 0) {
        const error = Object.assign(
          new Error('Pinned endpoint has no address in the requested family'),
          { code: 'ENOTFOUND' },
        );
        callback(error, []);
      } else if (options.all) callback(null, eligible);
      else callback(null, eligible[0]!.address, eligible[0]!.family);
    };
    agent = new Agent({ connect: { lookup } });
    // undici's RequestInit is structurally narrower than the DOM one (Blob, BodyInit), so the call
    // is typed through unknown. The runtime shapes are the same.
    const dispatched = undiciFetch as unknown as (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>;
    fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
      dispatched(input, { ...init, dispatcher: agent } as RequestInit)) as typeof globalThis.fetch;
  }

  return {
    async fetch(input, init = {}) {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (!sameApprovedDestination(url, approved)) {
        throw new ExecutionPolicyError('Request destination is not the operator-approved endpoint');
      }
      const response = await fetchImpl(input, { ...init, redirect: 'manual' });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        throw new ToolInvocationError('Tool endpoint redirects are forbidden', 'not-applied');
      }
      return limitResponseBody(response, maxResponseBytes);
    },
    async dispose() {
      await agent?.close();
    },
  };
}
