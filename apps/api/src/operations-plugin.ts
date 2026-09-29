import { definePlugin, manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import { Cap, type CarrierControlFactory } from '@winsendotai/ovo-contracts';
import type { ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import { ApiCarrierHandoffPort } from './carrier-handoff.ts';
import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import {
  createOperationsRuntime,
  type CreateOperationsRuntimeOptions,
} from './operations-runtime.ts';

export const OPERATIONS_RUNTIME_PLUGIN_ID = '@winsendotai/ovo-api-operations-runtime';
export function createOperationsRuntimePlugin(
  options: CreateOperationsRuntimeOptions & {
    pluginCatalog?: readonly PluginDefinition[];
  },
) {
  return definePlugin(
    {
      id: OPERATIONS_RUNTIME_PLUGIN_ID,
      version: '1.0.0',
      contractVersion: 2,
      scope: 'process',
      kind: 'host',
      requires: [Cap.controlStore, Cap.secretManager],
      optional: [Cap.carrierControl],
      provides: [Cap.operations],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx, config) => {
      const controls = ctx.all(Cap.carrierControl);
      const carrierPort =
        options.pluginCatalog && controls.size
          ? new ApiCarrierHandoffPort({
              organizationId: options.organizationId,
              catalog: options.pluginCatalog,
              ctx,
              store: ctx.get(Cap.controlStore) as ControlStore,
              secrets: ctx.get(Cap.secretManager) as SecretManager,
              environment: options.environment ?? process.env,
            })
          : undefined;
      const runtime = await createOperationsRuntime({
        maxConnections: 2,
        ...options,
        handoffProvider: carrierPort ?? options.handoffProvider,
      });
      carrierPort?.attach(runtime.service.pool);
      if (options.pluginCatalog)
        registerCampaignCarrierResolver(runtime.service, options.pluginCatalog, controls);
      ctx.provide(Cap.operations, runtime.service);
      ctx.effect(() => () => runtime.close());
    },
  );
}

export interface CampaignCarrierSnapshot {
  carrierPluginId: string;
  carrierId: string;
  carrierBindingId: string | null;
  bindingCps: number | null;
}

type Resolver = (release: ReleaseRecord, store: ControlStore) => Promise<CampaignCarrierSnapshot>;
const resolvers = new WeakMap<OperationsService, Resolver>();
const inboundValidators = new WeakMap<
  OperationsService,
  (
    workspaceId: string,
    pluginId: string | null | undefined,
    bindingId: string | null | undefined,
    store: ControlStore,
  ) => Promise<void>
>();

export function registerCampaignCarrierResolver(
  service: OperationsService,
  catalog: readonly PluginDefinition[],
  controls: ReadonlyMap<string, CarrierControlFactory>,
): void {
  const installed = catalog.flatMap((definition) => {
    const manifest = manifestKeys(definition.manifest);
    if (!manifest.provides.some((item) => item.key === Cap.carrierControl)) return [];
    const factory = controls.get(manifest.manifest.provider ?? definition.manifest.id);
    return factory
      ? [{ id: definition.manifest.id, version: definition.manifest.version, factory }]
      : [];
  });
  const registry = new PluginRegistry(catalog);
  inboundValidators.set(service, async (workspaceId, pluginId, bindingId, store) => {
    if (bindingId && !pluginId) throw new Error('Inbound carrier binding requires plugin ID');
    if (pluginId && !installed.some((item) => item.id === pluginId))
      throw new Error('Inbound carrier control is not installed');
    if (!bindingId) return;
    const binding = await store.getProviderBinding(workspaceId, bindingId);
    if (
      !binding ||
      binding.workspaceId !== workspaceId ||
      binding.kind !== 'carrier' ||
      binding.pluginId !== pluginId
    )
      throw new Error('Inbound carrier binding is unavailable or mismatched');
  });
  resolvers.set(service, async (release) => {
    const selection = release.selections?.carrier;
    const legacy = release.providerBindings.telephony;
    const pin = selection
      ? registry.resolvePin(selection.pluginId, selection.version).definition
      : undefined;
    const candidates = selection
      ? installed.filter(
          (item) => item.id === pin?.manifest.id && item.version === pin.manifest.version,
        )
      : legacy
        ? installed.filter(
            (item) =>
              item.factory.capabilities.carrierId === legacy.provider &&
              (!legacy.pluginId || item.id === legacy.pluginId),
          )
        : installed;
    const carrier = candidates.length === 1 ? candidates[0] : undefined;
    if (!carrier) throw new Error('Campaign carrier control is not installed for release');
    const bindingId = selection
      ? selection.bindingId === 'env'
        ? undefined
        : selection.bindingId
      : legacy?.id === 'env'
        ? undefined
        : legacy?.id;
    if (selection && bindingId && !selection.binding)
      throw new Error('Campaign carrier release has no pinned binding snapshot');
    if (legacy && legacy.workspaceId !== release.workspaceId)
      throw new Error('Campaign carrier binding is from another workspace');
    const cps = selection?.binding?.config.cps ?? legacy?.config.cps;
    if (cps !== undefined && (typeof cps !== 'number' || !Number.isFinite(cps) || cps <= 0))
      throw new Error('Campaign carrier binding cps is invalid');
    return {
      carrierPluginId: carrier.id,
      carrierId: carrier.factory.capabilities.carrierId,
      carrierBindingId: bindingId ?? null,
      bindingCps: cps ?? null,
    };
  });
}

export function validateInboundCarrier(
  service: OperationsService,
  workspaceId: string,
  pluginId: string | null | undefined,
  bindingId: string | null | undefined,
  store: ControlStore,
): Promise<void> {
  if (!pluginId && !bindingId) return Promise.resolve();
  const validate = inboundValidators.get(service);
  if (!validate) throw new Error('Inbound carrier catalog is unavailable');
  return validate(workspaceId, pluginId, bindingId, store);
}

export function resolveCampaignCarrier(
  service: OperationsService,
  release: ReleaseRecord,
  store: ControlStore,
): Promise<CampaignCarrierSnapshot> {
  const resolver = resolvers.get(service);
  if (!resolver) throw new Error('Campaign carrier catalog is unavailable');
  return resolver(release, store);
}
