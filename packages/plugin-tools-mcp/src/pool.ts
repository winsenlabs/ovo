import { createHash } from 'node:crypto';
import type { ToolConnection } from '@winsendotai/ovo-contracts';
import { ConnectorPolicyError } from '@winsendotai/ovo-plugin-kit';
import { connectClient, type McpConnectorDependencies, type PooledClient } from './transport.ts';

interface Entry {
  connection: string;
  client: Promise<PooledClient>;
  usedAt: number;
  refs: number;
  retired: boolean;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}

export class McpClientPool {
  private readonly entries = new Map<string, Entry>();
  private readonly all = new Set<Entry>();
  private closed = false;
  private allocation: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly idleTtl: number;
  private readonly max: number;
  constructor(private readonly dependencies: McpConnectorDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.idleTtl = dependencies.idleTtlMs ?? 300_000;
    this.max = dependencies.maxClients ?? 32;
    if (
      !Number.isSafeInteger(this.max) ||
      this.max < 1 ||
      !Number.isFinite(this.idleTtl) ||
      this.idleTtl <= 0 ||
      (dependencies.discoveryTtlMs !== undefined && !(dependencies.discoveryTtlMs > 0))
    )
      throw new ConnectorPolicyError('MCP pool limits must be positive');
  }
  private retire(key: string, entry: Entry) {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    entry.retired = true;
    clearTimeout(entry.timer);
    if (!entry.refs) void this.close(entry);
  }
  private close(entry: Entry): Promise<void> {
    entry.closing ??= entry.client
      .then((client) => client.close())
      .catch(() => undefined)
      .finally(() => this.all.delete(entry));
    return entry.closing;
  }
  private async credential(connection: ToolConnection): Promise<string | undefined> {
    if (connection.auth === 'none') return undefined;
    if (!this.dependencies.secrets || !connection.credentialId)
      throw new ConnectorPolicyError('MCP authentication requires a server-side secret resolver');
    try {
      return await this.dependencies.secrets.resolve(
        connection.workspaceId,
        connection.credentialId,
      );
    } catch {
      throw new ConnectorPolicyError('MCP credential resolution failed');
    }
  }
  private async acquire(connection: ToolConnection, signal?: AbortSignal) {
    const previous = this.allocation;
    let release!: () => void;
    this.allocation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.allocate(connection, signal);
    } finally {
      release();
    }
  }

  private async allocate(connection: ToolConnection, signal?: AbortSignal) {
    if (this.closed) throw new ConnectorPolicyError('MCP connector is disposed');
    signal?.throwIfAborted();
    const identity = JSON.stringify([connection.workspaceId, connection.id]);
    let secret: string | undefined;
    try {
      secret = await this.credential(connection);
    } catch (error) {
      for (const [key, entry] of this.entries)
        if (entry.connection === identity) this.retire(key, entry);
      throw error;
    }
    if (this.closed) throw new ConnectorPolicyError('MCP connector is disposed');
    // Local adapter: SecretResolver lacks a version port. Never retain/log the plaintext in a key.
    const digest =
      secret === undefined ? 'anonymous' : createHash('sha256').update(secret).digest('hex');
    const key = `${identity}:${digest}`;
    for (const [otherKey, entry] of this.entries) {
      if (
        (entry.connection === identity && otherKey !== key) ||
        (!entry.refs && this.now() - entry.usedAt >= this.idleTtl)
      )
        this.retire(otherKey, entry);
    }
    let entry = this.entries.get(key);
    if (!entry) {
      for (const [oldKey, old] of [...this.entries].sort((a, b) => a[1].usedAt - b[1].usedAt)) {
        if (this.all.size < this.max) break;
        if (!old.refs) this.retire(oldKey, old);
      }
      // Retired clients still occupy sockets while callers hold them. Only completed closure
      // releases capacity; a credential rotation cannot evade the live-client bound.
      await Promise.all(
        [...this.all].filter((old) => old.retired && !old.refs).map((old) => this.close(old)),
      );
      if (this.closed) throw new ConnectorPolicyError('MCP connector is disposed');
      signal?.throwIfAborted();
      if (this.all.size >= this.max)
        throw new ConnectorPolicyError('MCP client pool is at capacity');
      entry = {
        connection: identity,
        client: connectClient(connection.endpoint, secret, this.dependencies, signal),
        usedAt: this.now(),
        refs: 0,
        retired: false,
      };
      this.entries.set(key, entry);
      this.all.add(entry);
    }
    const acquired = entry;
    acquired.refs += 1;
    clearTimeout(acquired.timer);
    return { key, acquired };
  }

  async use<T>(
    connection: ToolConnection,
    signal: AbortSignal | undefined,
    use: (client: PooledClient) => Promise<T>,
  ): Promise<T> {
    const { key, acquired } = await this.acquire(connection, signal);
    try {
      let client: PooledClient;
      try {
        client = await acquired.client;
      } catch (error) {
        this.retire(key, acquired);
        throw error;
      }
      signal?.throwIfAborted();
      return await use(client);
    } finally {
      acquired.refs -= 1;
      acquired.usedAt = this.now();
      if (acquired.retired) {
        if (!acquired.refs) await this.close(acquired);
      } else if (!acquired.refs) {
        acquired.timer = setTimeout(() => this.retire(key, acquired), this.idleTtl);
        acquired.timer.unref?.();
      }
    }
  }
  async dispose(): Promise<void> {
    this.closed = true;
    for (const [key, entry] of this.entries) this.retire(key, entry);
    // Shutdown cancels active SDK requests as well as idle transports.
    await Promise.all([...this.all].map((entry) => this.close(entry)));
  }
}
