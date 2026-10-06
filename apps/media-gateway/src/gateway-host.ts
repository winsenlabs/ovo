import type {
  AgentConfig,
  CarrierHostPorts,
  CarrierIngress,
  InboundAdmission,
  NormalizedCallEvent,
  ReleaseSelections,
  SecretResolver,
} from '@winsendotai/ovo-contracts';
import { legacyEnvBindings, type LoadedDistribution } from '@winsendotai/ovo-distribution';
import type { PostgresOperationsService } from '@winsendotai/ovo-plugin-operations';
import type { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import {
  createCarrierBindingResolver,
  createCarrierHostPorts,
  validateSelections,
  type CarrierBindingRow,
} from '@winsendotai/ovo-session-host';
import type { GatewayHealth } from './gateway-health.ts';
import { createInboundAdmission } from './inbound-admission.ts';
import { projectInboundTerminalStatus } from './inbound-status.ts';

type CallbackStatus = Parameters<PostgresOrchestrationStore['applyCarrierCallback']>[0]['status'];

function callbackStatus(state: NormalizedCallEvent['state']): CallbackStatus {
  switch (state) {
    case 'queued':
      return 'initiated';
    case 'ringing':
      return 'ringing';
    case 'in_progress':
      return 'answered';
    case 'completed':
      return 'completed';
    case 'busy':
      return 'busy';
    case 'no_answer':
      return 'no_answer';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'cancelled';
  }
}

/** A completed carrier leg is successful only after a real session opened and no machine answered. */
export function campaignAttemptStatus(input: {
  state: NormalizedCallEvent['state'];
  answeredBy?: NormalizedCallEvent['answeredBy'];
  sessionOpened: boolean;
}): 'dialing' | 'connected' | 'succeeded' | 'cancelled' | 'failed' {
  if (input.state === 'in_progress') return 'connected';
  if (input.state === 'completed')
    return input.sessionOpened && input.answeredBy !== 'machine' ? 'succeeded' : 'failed';
  if (input.state === 'canceled') return 'cancelled';
  if (input.state === 'busy' || input.state === 'failed' || input.state === 'no_answer')
    return 'failed';
  return 'dialing';
}

export interface GatewayHostOptions {
  publicBaseUrl: string;
  routeSecret: string;
  store: PostgresOrchestrationStore;
  operations: PostgresOperationsService;
  distribution: LoadedDistribution;
  control: {
    getProviderBinding(workspaceId: string, id: string): Promise<CarrierBindingRow | undefined>;
    getRelease(
      workspaceId: string,
      id: string,
    ): Promise<
      | {
          config: AgentConfig;
          selections?: ReleaseSelections;
          providerBindings?: Parameters<typeof validateSelections>[0]['legacyProviderBindings'];
        }
      | undefined
    >;
  };
  secrets: SecretResolver;
  ingresses: readonly CarrierIngress[];
  environmentCarrierId?: string;
  env: Readonly<Record<string, string | undefined>>;
  health?: GatewayHealth;
}

/** Session-host owns URL signing and grants; this adapter supplies durable host ports. */
export function createGatewayHost(options: GatewayHostOptions) {
  const registry = new PluginRegistry(options.distribution.catalog);
  const env = legacyEnvBindings(options.env);
  const bindings = createCarrierBindingResolver({
    workspaceId: options.operations.organizationId,
    store: {
      getProviderBinding: async (workspaceId, id) => {
        const row = await options.control.getProviderBinding(workspaceId, id);
        return row ? { ...row, pluginId: row.pluginId ?? null } : undefined;
      },
    },
    secrets: options.secrets,
    registry,
    env,
  });
  const ingressById = new Map(options.ingresses.map((ingress) => [ingress.carrierId, ingress]));
  const validateBeforeAdmission = async (inbound: InboundAdmission): Promise<void> => {
    const selected = await options.operations.pool.query<{
      release_id: string;
      carrier_plugin_id: string | null;
      carrier_binding_id: string | null;
    }>(
      `SELECT release_id, carrier_plugin_id, carrier_binding_id
       FROM ovo_ops_inbound_routes
       WHERE organization_id = $1 AND phone_number = $2 AND enabled = true`,
      [options.operations.organizationId, inbound.to],
    );
    const route = selected.rows[0];
    if (!route) return; // Operations records the normal unrouted refusal.
    if (route.carrier_plugin_id && !registry.get(route.carrier_plugin_id)) return; // Operations records its durable uninstalled-plugin refusal.
    const bindingId = route.carrier_binding_id ?? 'env';
    if (bindingId !== inbound.bindingId)
      throw new Error('Inbound route binding differs from the authenticated request');
    if (!route.carrier_plugin_id && !route.carrier_binding_id) {
      if (!options.environmentCarrierId) return; // Operations records its durable env refusal.
      if (options.environmentCarrierId !== inbound.carrierId)
        throw new Error('Inbound route environment carrier differs from the authenticated request');
    }
    const binding = await bindings(bindingId, inbound.carrierId);
    if (route.carrier_plugin_id && route.carrier_plugin_id !== binding.pluginId)
      throw new Error('Inbound route carrier plugin differs from the resolved binding');
    const definition = registry.get(binding.pluginId);
    if (!definition) throw new Error('Inbound route carrier plugin is not installed');
    const release = await options.control.getRelease(
      options.operations.organizationId,
      route.release_id,
    );
    if (!release) throw new Error('Inbound route release is not installed');
    const issues = validateSelections(
      {
        config: release.config,
        selections: release.selections as ReleaseSelections | undefined,
        actualCarrier: {
          pluginId: binding.pluginId,
          version: definition.manifest.version,
          bindingId,
          config: structuredClone(binding.config),
        },
        registry,
        defaults: options.distribution.defaults,
        legacyProviderBindings: release.providerBindings,
        bindings: {
          [bindingId]: {
            pluginId: binding.pluginId,
            provider: inbound.carrierId,
            config: structuredClone(binding.config),
          },
        },
        priceCards: release.config.costPolicy?.priceCards,
      },
      'live',
    ).filter((issue) => issue.severity === 'error');
    if (issues.length)
      throw new Error(
        `Inbound compatibility blocked: ${issues.map((issue) => issue.code).join(',')}`,
      );
  };
  const ports = new Map<string, CarrierHostPorts>();
  const hostFor = (carrierId: string, bindingId: string): CarrierHostPorts => {
    const ingress = ingressById.get(carrierId);
    if (!ingress) throw new Error(`Carrier ingress is not installed: ${carrierId}`);
    const key = `${carrierId}:\0${bindingId}`;
    const cached = ports.get(key);
    if (cached) return cached;
    const created = createCarrierHostPorts({
      publicBaseUrl: options.publicBaseUrl,
      routeSecret: options.routeSecret,
      operations: admission,
      orchestration: {
        resolveSessionRoute: options.store.resolveSessionRoute.bind(options.store),
        issueStreamGrant: options.store.issueStreamGrant.bind(options.store),
        reissueStream: options.store.reissueStream.bind(options.store),
        recordCarrierCallIdMismatch: options.store.recordCarrierCallIdMismatch.bind(options.store),
        async applyCallEvent(event) {
          const result = await options.store.applyCarrierCallback({
            organizationId: options.operations.organizationId,
            carrierId: event.carrierId,
            provider: event.carrierId,
            eventId: event.eventId,
            carrierCallId: event.carrierCallId,
            carrierRequestId: event.carrierRequestId,
            dialRequestId: event.dialRequestId,
            status: callbackStatus(event.state),
            occurredAt: event.occurredAt,
            payload: {
              ...event.payload,
              ...(event.answeredBy ? { answeredBy: event.answeredBy } : {}),
            },
          });
          if (result.kind === 'unmatched' || result.kind === 'correlation_conflict') {
            options.health?.rejection(`status callback ${result.kind}`, event.carrierCallId);
            return result;
          }
          const job = await options.store.get(result.route.jobId);
          if (job?.payload.kind === 'inbound_call')
            await projectInboundTerminalStatus(options.operations, {
              carrierCallId: event.carrierCallId ?? '',
              status: callbackStatus(event.state),
            });
          const attemptId = job?.payload.attemptId;
          if (typeof attemptId === 'string' && attemptId) {
            const evidence =
              event.state === 'completed'
                ? await options.store.pool.query<{
                    session_opened: boolean;
                    machine_answered: boolean;
                  }>(
                    `SELECT
                       EXISTS (SELECT 1 FROM ovo_carrier_callbacks
                         WHERE organization_id = $1 AND carrier_id = $2 AND session_id = $3
                           AND provider = 'ovo.media' AND status = 'session_opened') AS session_opened,
                       EXISTS (SELECT 1 FROM ovo_carrier_callbacks
                         WHERE organization_id = $1 AND carrier_id = $2 AND session_id = $3
                           AND provider = $2 AND payload->>'answeredBy' = 'machine') AS machine_answered`,
                    [result.route.organizationId, event.carrierId, result.route.sessionId],
                  )
                : undefined;
            const observed = evidence?.rows[0];
            await options.operations.campaigns.recordAttempt(
              attemptId,
              event.eventId,
              campaignAttemptStatus({
                state: event.state,
                answeredBy: observed?.machine_answered ? 'machine' : event.answeredBy,
                sessionOpened: observed?.session_opened === true,
              }),
              event.occurredAt,
            );
          }
          return result.kind === 'ignored_out_of_order'
            ? { kind: 'duplicate' as const }
            : { kind: result.kind };
        },
      },
      bindings,
      carrierId,
      queryOnMediaUrl: () => ingress.capabilities.media.queryOnMediaUrl,
      streamCallIdMatchesDial: () => ingress.capabilities.control.streamCallIdMatchesDial,
    });
    ports.set(key, created);
    return created;
  };
  const admission = createInboundAdmission({
    operations: options.operations,
    routeSecret: options.routeSecret,
    hostFor,
    validateBeforeAdmission,
    health: options.health,
  });
  return { hostFor };
}
