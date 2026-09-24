import {
  type CarrierHostPorts,
  type ReleaseSelections,
  type TelephonyControl,
} from '@winsendotai/ovo-contracts';
import { legacyEnvBindings } from '@winsendotai/ovo-distribution';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import {
  deriveLegacySelections,
  type ControlStore,
  type ReleaseRecord,
} from '@winsendotai/ovo-plugin-storage';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import type {
  PostgresOrchestrationStore,
  TelephonyControl as LegacyTelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import {
  CarrierRegistry,
  createCarrierBindingResolver,
  createCarrierHostPorts,
  validateSelections,
  type InstalledCarrierControl,
  type SelectedCarrier,
  type SessionDefaults,
} from '@winsendotai/ovo-session-host';

export interface CarrierJob {
  id: string;
  workspaceId: string;
  ownerEpoch: number;
  payload: Record<string, unknown>;
}

export interface SelectedJobCarrier {
  release: ReleaseRecord;
  selections: ReleaseSelections;
  carrier: SelectedCarrier;
  control: TelephonyControl;
  ports: CarrierHostPorts;
}

/** Resolve a carrier per job from the immutable release, including pre-selection releases. */
export class WorkerCarrierRuntime {
  constructor(
    private readonly input: {
      registry: PluginRegistry;
      controls: ReadonlyMap<string, InstalledCarrierControl>;
      store: ControlStore;
      secrets: SecretManager;
      defaults: SessionDefaults;
      env: Readonly<Record<string, string | undefined>>;
      publicBaseUrl: string;
      routeSecret: string;
    },
  ) {}

  async forJob(job: CarrierJob, admission = true): Promise<SelectedJobCarrier> {
    const releaseId = job.payload.releaseId;
    if (typeof releaseId !== 'string' || !releaseId)
      throw new Error(`Job ${job.id} has no immutable release`);
    const release = await this.input.store.getRelease(job.workspaceId, releaseId);
    if (!release) throw new Error(`Release ${releaseId} is not installed in ${job.workspaceId}`);
    const selections = this.selections(release, job);
    if (!selections.carrier) throw new Error('Live release has no carrier selection');
    const resolver = createCarrierBindingResolver({
      workspaceId: job.workspaceId,
      store: {
        getProviderBinding: async (workspaceId, id) => {
          const frozen = selections.carrier;
          if (frozen?.bindingId === id && frozen.binding) {
            return {
              id,
              workspaceId,
              provider: frozen.binding.provider,
              pluginId: frozen.pluginId,
              credentialId: frozen.binding.credentialId,
              config: structuredClone(frozen.binding.config),
            };
          }
          const row = await this.input.store.getProviderBinding(workspaceId, id);
          return row ? { ...row, pluginId: row.pluginId ?? null } : undefined;
        },
      },
      secrets: this.input.secrets.forAgent(release.agentId),
      registry: this.input.registry,
      env: legacyEnvBindings(this.input.env),
    });
    const carriers = new CarrierRegistry(this.input.controls, resolver);
    const carrier = await carriers.forRelease({ selections });
    const bindingCheck = this.input.registry.validateBinding(
      carrier.binding.pluginId,
      carrier.binding.config,
    );
    if (!bindingCheck.ok) throw new Error(`Carrier binding schema invalid: ${bindingCheck.errors}`);
    const actualCarrier = {
      pluginId: carrier.binding.pluginId,
      version: this.input.registry.get(carrier.binding.pluginId)!.manifest.version,
      bindingId: carrier.bindingId,
      config: structuredClone(carrier.binding.config),
    };
    const issues = admission
      ? validateSelections(
          {
            config: release.config,
            selections,
            actualCarrier,
            registry: this.input.registry,
            defaults: this.input.defaults,
            legacyProviderBindings: release.providerBindings,
            priceCards: release.config.costPolicy?.priceCards,
          },
          'live',
        ).filter((issue) => issue.severity === 'error')
      : [];
    if (issues.length)
      throw new Error(`Live compatibility blocked: ${issues.map((issue) => issue.code).join(',')}`);
    const ports = createCarrierHostPorts({
      publicBaseUrl: this.input.publicBaseUrl,
      routeSecret: this.input.routeSecret,
      operations: {
        admitInbound: async () => {
          throw new Error('Worker URL builder cannot admit inbound calls');
        },
        confirmCallback: async () => {
          throw new Error('Worker URL builder cannot confirm callbacks');
        },
      },
      orchestration: {} as Parameters<typeof createCarrierHostPorts>[0]['orchestration'],
      bindings: resolver,
      carrierId: carrier.carrierId,
      queryOnMediaUrl: () => carrier.capabilities.media.queryOnMediaUrl,
    });
    return {
      release,
      selections,
      carrier,
      control: carrier.control.create(carrier.binding),
      ports,
    };
  }

  private selections(release: ReleaseRecord, job: CarrierJob): ReleaseSelections {
    if (job.payload.kind === 'inbound_call' && Object.hasOwn(job.payload, 'carrierPluginId')) {
      const rawPluginId = job.payload.carrierPluginId;
      const rawBindingId = job.payload.carrierBindingId;
      if (rawPluginId !== null && (typeof rawPluginId !== 'string' || !rawPluginId))
        throw new Error('Inbound route carrier plugin is invalid');
      if (rawBindingId !== null && (typeof rawBindingId !== 'string' || !rawBindingId))
        throw new Error('Inbound route carrier binding is invalid');
      const pluginId = rawPluginId ?? this.environmentCarrierPluginId();
      const definition = this.input.registry.get(pluginId);
      if (!definition) throw new Error(`Inbound carrier control is not installed: ${pluginId}`);
      return {
        ...release.selections,
        carrier: {
          pluginId,
          version: definition.manifest.version,
          bindingId: rawBindingId ?? 'env',
          config: {},
        },
      };
    }
    if (Object.keys(release.selections ?? {}).length) return release.selections!;
    const legacy = deriveLegacySelections(release, this.input.registry, {
      engine: this.input.defaults.engine,
      turnDetector: this.input.defaults.turnDetector,
    });
    if (!legacy.carrier) {
      const pluginId = this.environmentCarrierPluginId();
      legacy.carrier = { pluginId, bindingId: 'env', config: {} };
    }
    return Object.fromEntries(
      Object.entries(legacy).map(([slot, choice]) => [
        slot,
        {
          ...choice,
          version: this.input.registry.get(choice.pluginId)!.manifest.version,
        },
      ]),
    ) as ReleaseSelections;
  }

  private environmentCarrierPluginId(): string {
    const entries = Object.keys(
      JSON.parse(legacyEnvBindings(this.input.env).OVO_CARRIER_ENV_BINDINGS ?? '{}') as Record<
        string,
        unknown
      >,
    );
    if (entries.length !== 1) throw new Error('Exactly one environment carrier is required');
    return this.input.registry.resolve('carrier', entries[0]!).manifest.id;
  }
}

/** Transitional v1 seam for the existing inbound and budget callbacks. Outbound dialing uses v2. */
export function legacyCarrierControl(
  carriers: WorkerCarrierRuntime,
  orchestration: PostgresOrchestrationStore,
): LegacyTelephonyControl {
  const selectedForCall = async (carrierCallId: string) => {
    const route = await orchestration.resolveSessionRoute({ carrierCallId });
    const job = route && (await orchestration.get(route.jobId));
    if (!route || !job) throw new Error(`Carrier call ${carrierCallId} has no durable route`);
    return carriers.forJob(job, false);
  };
  return {
    dial: async () => {
      throw new Error('Legacy carrier dial is disabled in the F4 worker');
    },
    async reconcile(requestId, carrierCallId) {
      const jobId = requestId.slice(0, requestId.lastIndexOf(':'));
      const job = await orchestration.get(jobId);
      if (!job) return { kind: 'pending' };
      const selected = await carriers.forJob(job, false);
      const result = await selected.control.reconcile({ requestId, carrierCallId });
      if (result.kind === 'live' && result.carrierCallId)
        return { kind: 'accepted', carrierCallId: result.carrierCallId };
      if (result.kind === 'rejected') return { kind: 'rejected', reason: result.reason };
      if (result.kind === 'ended') return { kind: 'rejected', reason: result.state };
      return { kind: 'pending' };
    },
    async hangup(carrierCallId) {
      const selected = await selectedForCall(carrierCallId);
      const result = await selected.control.hangup({ carrierCallId });
      if (result === 'unsupported') throw new Error('Carrier does not support REST hangup');
    },
    transfer: async () => {
      throw new Error('Legacy transfer is disabled; use carrier handoff');
    },
  };
}
