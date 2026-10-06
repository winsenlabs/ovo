/**
 * The address policy behind the production `ovo.net` (#24). Every socket `createNodeNet` opens is
 * built here, so no fetch and no WebSocket can reach a link-local, loopback, RFC 1918 or otherwise
 * special-use address.
 *
 * A kit may not import node built-ins (§13.3), so undici's `buildConnector` owns the node:net and
 * node:tls call and this module owns the policy around it:
 *
 * 1. `assertPublicHost` judges the host before anything is opened, and returns the addresses the
 *    connection is pinned to;
 * 2. those addresses become the connector's `lookup`, so DNS is consulted once and the socket can
 *    only be dialled at an address that was already validated — a later DNS answer cannot move it;
 * 3. the peer of the connected socket is checked again before the socket is handed to the caller,
 *    so a composition without a `lookup` (nothing to pin to) still cannot send a single request
 *    byte to a private address.
 */
import { Agent, buildConnector } from 'undici';
import { ConnectorPolicyError } from './tool-errors.ts';
import {
  addressAllowed,
  addressKey,
  type PublicHostOptions,
  type ResolvedAddress,
} from './ssrf.ts';

/** The TLS trust a test composition may hand the transport; production uses the system store. */
export interface TlsTrustOptions {
  ca?: string | Uint8Array | readonly (string | Uint8Array)[];
  rejectUnauthorized?: boolean;
}

export interface AddressPolicy extends PublicHostOptions {
  /**
   * Addresses `assertPublicHost` already validated. The connection may reach no other address.
   * Empty means nothing could be resolved here, and only the peer check applies.
   */
  addresses: readonly ResolvedAddress[];
}

type LookupResult = { address: string; family: number };
type LookupCallback = (
  error: Error | null,
  address: string | LookupResult[],
  family?: number,
) => void;

/** Resolution is already done: hand back the validated addresses and never consult DNS again. */
function pinnedLookup(addresses: readonly ResolvedAddress[]) {
  return (_host: string, options: { family?: number; all?: boolean }, callback: LookupCallback) => {
    const eligible = options.family
      ? addresses.filter(({ family }) => family === options.family)
      : addresses;
    const first = eligible[0];
    if (!first) {
      const error = Object.assign(new Error('Pinned host has no address in that family'), {
        code: 'ENOTFOUND',
      });
      callback(error, []);
    } else if (options.all) {
      callback(
        null,
        eligible.map(({ address, family }) => ({ address, family })),
      );
    } else callback(null, first.address, first.family);
  };
}

function permits(policy: AddressPolicy, address: string): boolean {
  if (!addressAllowed(address, policy)) return false;
  if (policy.addresses.length === 0) return true;
  const key = addressKey(address);
  return policy.addresses.some((pin) => addressKey(pin.address) === key);
}

/**
 * undici's connector with the address policy around it. The socket is destroyed, and the caller
 * gets a `ConnectorPolicyError`, before any byte of the request is written.
 */
export function createGuardedConnector(
  policy: AddressPolicy,
  tls: TlsTrustOptions = {},
): buildConnector.connector {
  const base = buildConnector({
    ...tls,
    // HTTP/1.1 only: the WebSocket upgrade and the pinned fetch both speak it.
    allowH2: false,
    ...(policy.addresses.length ? { lookup: pinnedLookup(policy.addresses) } : {}),
  } as buildConnector.BuildOptions);
  return (options, callback) => {
    base(options, (error, socket) => {
      if (error || !socket) {
        callback(error ?? new ConnectorPolicyError('Connection failed'), null);
        return;
      }
      const peer = socket.remoteAddress ?? '';
      if (permits(policy, peer)) {
        callback(null, socket);
        return;
      }
      socket.destroy();
      callback(
        new ConnectorPolicyError(
          `Refused a connection to the non-public address ${peer || '(unknown)'}`,
        ),
        null,
      );
    });
  };
}

/**
 * How long an idle pooled connection is kept. undici's default (4s) is shorter than the gap
 * between two caller turns, so the decision, LLM and TTS requests re-did TCP+TLS on most turns
 * (LAT-8). A server `Keep-Alive: timeout=` hint still wins, capped at `keepAliveMaxTimeoutMs`.
 */
export interface KeepAliveOptions {
  keepAliveTimeoutMs?: number;
  keepAliveMaxTimeoutMs?: number;
}

export const DEFAULT_KEEP_ALIVE: Required<KeepAliveOptions> = Object.freeze({
  keepAliveTimeoutMs: 60_000,
  keepAliveMaxTimeoutMs: 300_000,
});

/** A dispatcher for `fetch` whose every connection passes `createGuardedConnector`. */
export function createPinnedAgent(
  policy: AddressPolicy,
  tls: TlsTrustOptions = {},
  keepAlive: KeepAliveOptions = {},
): Agent {
  return new Agent({
    connect: createGuardedConnector(policy, tls),
    keepAliveTimeout: keepAlive.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE.keepAliveTimeoutMs,
    keepAliveMaxTimeout:
      keepAlive.keepAliveMaxTimeoutMs ?? DEFAULT_KEEP_ALIVE.keepAliveMaxTimeoutMs,
  });
}

/** Keeps one guarded dispatcher per host and pin, so keep-alive survives without losing the pin. */
export class PinnedAgents {
  private readonly agents = new Map<string, Agent>();

  constructor(
    private readonly tls: TlsTrustOptions = {},
    private readonly limit = 64,
    private readonly keepAlive: KeepAliveOptions = {},
  ) {}

  for(hostname: string, policy: AddressPolicy): Agent {
    // Sorted: a DNS answer that only rotates its order must keep the pooled connections.
    const pins = policy.addresses.map(({ address }) => address).sort();
    const key = `${hostname}|${pins.join(',')}`;
    const existing = this.agents.get(key);
    if (existing) return existing;
    for (const [oldest, agent] of this.agents) {
      if (this.agents.size < this.limit) break;
      this.agents.delete(oldest);
      // swallow-ok: an evicted pool only holds idle sockets; closing it is best effort.
      void agent.close().catch(() => undefined);
    }
    const agent = createPinnedAgent(policy, this.tls, this.keepAlive);
    this.agents.set(key, agent);
    return agent;
  }

  async close(): Promise<void> {
    const agents = [...this.agents.values()];
    this.agents.clear();
    // swallow-ok: shutdown releases idle sockets; one failed close must not keep the others open.
    await Promise.all(agents.map((agent) => agent.close().catch(() => undefined)));
  }
}
