import {
  Cap,
  type CarrierControlFactory,
  type HandoffTarget as CarrierTarget,
} from '@winsendotai/ovo-contracts';
import { legacyEnvBindings } from '@winsendotai/ovo-distribution';
import type {
  HandoffProviderPort,
  HandoffTarget,
  HandoffFallback,
} from '@winsendotai/ovo-plugin-operations';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import {
  CarrierRegistry,
  createCarrierBindingResolver,
  type InstalledCarrierControl,
} from '@winsendotai/ovo-session-host';
import {
  manifestKeys,
  PluginRegistry,
  type PluginContext,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import type { Pool } from 'pg';

/** The operations ledger keeps its retry semantics; each attempt uses the call's durable carrier. */
export class ApiCarrierHandoffPort implements HandoffProviderPort {
  private pool?: Pool;

  constructor(
    private readonly input: {
      organizationId: string;
      catalog: readonly PluginDefinition[];
      ctx: PluginContext;
      store: ControlStore;
      secrets: SecretManager;
      environment: Readonly<Record<string, string | undefined>>;
    },
  ) {}

  attach(pool: Pool): void {
    this.pool = pool;
  }

  async request(input: { requestId: string; carrierCallId: string; target: HandoffTarget }) {
    const control = await this.forCall(input.requestId, input.carrierCallId);
    return control.handoff(input.carrierCallId, target(input.target), input.requestId);
  }

  async fallback(input: { requestId: string; carrierCallId: string; fallback: HandoffFallback }) {
    const control = await this.forCall(input.requestId, input.carrierCallId);
    return control.handoff(input.carrierCallId, fallback(input.fallback), input.requestId);
  }

  async reconcile(_requestId: string): Promise<{ kind: 'pending' }> {
    // No carrier handoff lookup exists by idempotency key. Unknown stays unknown.
    return { kind: 'pending' };
  }

  private async forCall(requestId: string, carrierCallId: string) {
    if (!this.pool) throw new Error('Carrier handoff store is not attached');
    const routes = await this.pool.query<{
      carrier_id: string;
      binding_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT r.carrier_id, r.binding_id, j.payload
       FROM ovo_ops_handoffs h
       JOIN ovo_session_routes r ON r.session_id::text = h.session_id
       JOIN ovo_jobs j ON j.id = r.job_id
       WHERE h.organization_id = $1 AND r.organization_id = h.organization_id
         AND h.carrier_call_id = $2 AND r.carrier_call_id = h.carrier_call_id
         AND (h.request_id = $3 OR h.fallback_request_id = $3)
       LIMIT 2`,
      [this.input.organizationId, carrierCallId, requestId],
    );
    if (routes.rowCount !== 1) throw new Error('Carrier handoff route is missing or ambiguous');
    const route = routes.rows[0]!;
    const releaseId = route.payload.releaseId;
    if (typeof releaseId !== 'string') throw new Error('Carrier handoff release is missing');
    const release = await this.input.store.getRelease(this.input.organizationId, releaseId);
    if (!release) throw new Error('Carrier handoff release is unavailable');
    const registry = new PluginRegistry(this.input.catalog);
    const controls = new Map<string, InstalledCarrierControl>();
    for (const definition of this.input.catalog) {
      const manifest = manifestKeys(definition.manifest);
      if (!manifest.provides.some((item) => item.key === Cap.carrierControl)) continue;
      const factory = this.input.ctx
        .all(Cap.carrierControl)
        .get(manifest.manifest.provider ?? definition.manifest.id) as
        CarrierControlFactory | undefined;
      if (factory)
        controls.set(definition.manifest.id, { version: definition.manifest.version, factory });
    }
    const selectedPlugin = [...controls].find(
      ([, control]) => control.factory.capabilities.carrierId === route.carrier_id,
    )?.[0];
    if (!selectedPlugin) throw new Error(`Carrier control is not installed: ${route.carrier_id}`);
    const resolver = createCarrierBindingResolver({
      workspaceId: this.input.organizationId,
      store: {
        getProviderBinding: async (workspaceId, id) => {
          const row = await this.input.store.getProviderBinding(workspaceId, id);
          return row ? { ...row, pluginId: row.pluginId ?? null } : undefined;
        },
      },
      secrets: this.input.secrets.forAgent(release.agentId),
      registry,
      env: legacyEnvBindings(this.input.environment),
    });
    const selected = await new CarrierRegistry(controls, resolver).forInboundRoute({
      carrierPluginId: selectedPlugin,
      carrierBindingId: route.binding_id,
    });
    return selected.control.create(selected.binding);
  }
}

function target(input: HandoffTarget): CarrierTarget {
  return input.kind === 'phone'
    ? { kind: 'phone', e164: input.value }
    : { kind: 'queue', name: input.value };
}

function fallback(input: HandoffFallback): CarrierTarget {
  if (input.kind === 'resume') return { kind: 'resume' };
  if (input.kind === 'end') return { kind: 'end', message: input.message };
  return { kind: 'phone', e164: input.target };
}
