import type { ResolvedBinding, SecretResolver } from '@winsendotai/ovo-contracts';
import { PluginRegistry } from '@winsendotai/ovo-runtime';

export interface CarrierBindingRow {
  id: string;
  workspaceId: string;
  provider: string;
  pluginId: string | null;
  credentialId: string;
  config: Record<string, unknown>;
}

export interface CarrierBindingSource {
  getProviderBinding(workspaceId: string, id: string): Promise<CarrierBindingRow | undefined>;
}

export interface CarrierBindingResolverOptions {
  workspaceId: string;
  store: CarrierBindingSource;
  secrets: SecretResolver;
  registry: PluginRegistry;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Values that mean "no credential": blank, bootstrap's `disabled-local-*`, the older
 * `not-configured` and `.env.example`'s `replace-with-*`. Shared by every env-binding check.
 */
export function isPlaceholderCredential(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  return (
    !trimmed ||
    trimmed === 'not-configured' ||
    trimmed.startsWith('disabled-local-') ||
    trimmed.startsWith('replace-with-')
  );
}

/** An env carrier entry whose account or token is a placeholder can only produce carrier 403s. */
export function isPlaceholderCarrierBinding(config: Record<string, unknown>): boolean {
  return (
    ('authToken' in config && isPlaceholderCredential(config.authToken)) ||
    ('accountSid' in config && isPlaceholderCredential(config.accountSid))
  );
}

/** The reserved binding id is resolved only on use; startup never validates placeholder env values. */
export function createCarrierBindingResolver(options: CarrierBindingResolverOptions) {
  return async (id: string, carrierId?: string): Promise<ResolvedBinding> => {
    if (id === 'env') {
      const raw = options.env?.OVO_CARRIER_ENV_BINDINGS;
      if (!raw) throw new Error('Environment carrier bindings are not configured');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('OVO_CARRIER_ENV_BINDINGS must be a JSON object');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('OVO_CARRIER_ENV_BINDINGS must be a JSON object');
      const entries = parsed as Record<string, unknown>;
      const selected =
        carrierId ?? (Object.keys(entries).length === 1 ? Object.keys(entries)[0] : undefined);
      if (!selected || !entries[selected] || typeof entries[selected] !== 'object')
        throw new Error('Environment carrier binding is ambiguous or missing');
      const config = entries[selected] as Record<string, unknown>;
      const token = config.authToken;
      if (
        typeof token !== 'string' ||
        isPlaceholderCredential(token) ||
        isPlaceholderCarrierBinding(config)
      )
        throw new Error('Environment carrier secret is not configured');
      const { authToken: _secret, ...publicConfig } = config;
      const definition = options.registry.resolve('carrier', selected);
      return {
        bindingId: 'env',
        pluginId: definition.manifest.id,
        workspaceId: options.workspaceId,
        config: publicConfig,
        secret: token,
      };
    }
    const row = await options.store.getProviderBinding(options.workspaceId, id);
    if (!row || row.workspaceId !== options.workspaceId)
      throw new Error(`Carrier binding is missing: ${id}`);
    if (carrierId && row.provider !== carrierId)
      throw new Error(`Carrier binding ${id} does not match ${carrierId}`);
    const pluginId = row.pluginId ?? options.registry.resolve('carrier', row.provider).manifest.id;
    const definition = options.registry.get(pluginId);
    if (!definition) throw new Error(`Carrier plugin is not installed: ${pluginId}`);
    const secret = await options.secrets.resolve(options.workspaceId, row.credentialId);
    return {
      bindingId: id,
      pluginId,
      workspaceId: options.workspaceId,
      config: row.config,
      secret,
    };
  };
}
