import type { Pool, PoolClient, QueryResultRow } from 'pg';

export interface InboundCarrierRoute extends QueryResultRow {
  release_id: string;
  variables: Record<string, string>;
  version: string;
  carrier_plugin_id: string | null;
  carrier_binding_id: string | null;
}

export async function selectInboundCarrierRoute(
  client: Pool | PoolClient,
  organizationId: string,
  toNumber: string,
): Promise<InboundCarrierRoute | undefined> {
  const result = await client.query<InboundCarrierRoute>(
    `SELECT release_id, variables, version, carrier_plugin_id, carrier_binding_id
     FROM ovo_ops_inbound_routes
     WHERE organization_id = $1 AND phone_number = $2 AND enabled = true`,
    [organizationId, toNumber],
  );
  return result.rows[0];
}

export class InstalledInboundCarrierPlugins {
  private carrierIds = new Map<string, string>();
  private environmentCarrierId?: string;
  private armed = false;

  set(
    plugins: Iterable<{ pluginId: string; carrierId: string }>,
    environmentCarrierId?: string,
  ): void {
    this.carrierIds = new Map(Array.from(plugins, (plugin) => [plugin.pluginId, plugin.carrierId]));
    this.environmentCarrierId = environmentCarrierId;
    this.armed = true;
  }

  assertArmed(): void {
    if (!this.armed) throw new InboundCarrierGateUnarmedError();
  }

  resolve(
    pluginId: string | null,
  ): { kind: 'selected'; carrierId: string } | { kind: 'refused'; reason: string } {
    this.assertArmed();
    if (pluginId === null)
      return this.environmentCarrierId
        ? { kind: 'selected', carrierId: this.environmentCarrierId }
        : { kind: 'refused', reason: 'inbound_carrier_configuration_env_unavailable' };
    const carrierId = this.carrierIds.get(pluginId);
    return carrierId
      ? { kind: 'selected', carrierId }
      : { kind: 'refused', reason: 'inbound_carrier_configuration_plugin_uninstalled' };
  }

  carrierId(pluginId: string | null): string {
    const result = this.resolve(pluginId);
    if (result.kind === 'selected') return result.carrierId;
    if (pluginId === null) throw new Error('Inbound environment carrier is not installed');
    throw new Error(`Inbound carrier plugin is not installed: ${pluginId}`);
  }
}

export class InboundCarrierGateUnarmedError extends Error {
  constructor() {
    super('Inbound carrier gate is not installed');
    this.name = 'InboundCarrierGateUnarmedError';
  }
}
