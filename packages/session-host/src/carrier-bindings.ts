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
        !token ||
        token === 'not-configured' ||
        token === 'disabled-local-account'
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
