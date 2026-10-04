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

/** A dispatcher for `fetch` whose every connection passes `createGuardedConnector`. */
export function createPinnedAgent(policy: AddressPolicy, tls: TlsTrustOptions = {}): Agent {
  return new Agent({ connect: createGuardedConnector(policy, tls) });
}

/** Keeps one guarded dispatcher per host and pin, so keep-alive survives without losing the pin. */
export class PinnedAgents {
  private readonly agents = new Map<string, Agent>();

  constructor(
    private readonly tls: TlsTrustOptions = {},
    private readonly limit = 64,
  ) {}

  for(hostname: string, policy: AddressPolicy): Agent {
    const key = `${hostname}|${policy.addresses.map(({ address }) => address).join(',')}`;
    const existing = this.agents.get(key);
    if (existing) return existing;
    for (const [oldest, agent] of this.agents) {
      if (this.agents.size < this.limit) break;
      this.agents.delete(oldest);
      void agent.close().catch(() => undefined);
    }
    const agent = createPinnedAgent(policy, this.tls);
    this.agents.set(key, agent);
    return agent;
  }

  async close(): Promise<void> {
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(agents.map((agent) => agent.close().catch(() => undefined)));
  }
}
