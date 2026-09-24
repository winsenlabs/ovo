import type { PoolClient, QueryResultRow } from 'pg';

export interface InboundCarrierRoute extends QueryResultRow {
  release_id: string;
  variables: Record<string, string>;
  version: string;
  carrier_plugin_id: string | null;
  carrier_binding_id: string | null;
}

export async function selectInboundCarrierRoute(
  client: PoolClient,
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

  set(
    plugins: Iterable<{ pluginId: string; carrierId: string }>,
    environmentCarrierId?: string,
  ): void {
    this.carrierIds = new Map(Array.from(plugins, (plugin) => [plugin.pluginId, plugin.carrierId]));
    this.environmentCarrierId = environmentCarrierId;
  }

  carrierId(pluginId: string | null): string {
    if (pluginId === null) {
      if (!this.environmentCarrierId)
        throw new Error('Inbound environment carrier is not installed');
      return this.environmentCarrierId;
    }
    const carrierId = this.carrierIds.get(pluginId);
    if (!carrierId) throw new Error(`Inbound carrier plugin is not installed: ${pluginId}`);
    return carrierId;
  }
}
