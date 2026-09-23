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
  private pluginIds = new Set<string>();

  set(pluginIds: Iterable<string>): void {
    this.pluginIds = new Set(pluginIds);
  }

  assert(pluginId: string | null): void {
    if (pluginId !== null && !this.pluginIds.has(pluginId))
      throw new Error(`Inbound carrier plugin is not installed: ${pluginId}`);
  }
}
