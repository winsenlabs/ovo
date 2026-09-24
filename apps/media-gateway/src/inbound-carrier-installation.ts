import { legacyEnvBindings, type LoadedDistribution } from '@winsendotai/ovo-distribution';
import { Cap } from '@winsendotai/ovo-contracts';
import type { PostgresOperationsService } from '@winsendotai/ovo-plugin-operations';
import { manifestKeys } from '@winsendotai/ovo-runtime';

/** Admission runs in the gateway process, so install its carrier controls there. */
export function installInboundCarriers(
  operations: PostgresOperationsService,
  distribution: Pick<LoadedDistribution, 'catalog'>,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const installed = distribution.catalog
    .filter((definition) =>
      manifestKeys(definition.manifest).provides.some((entry) => entry.key === Cap.carrierControl),
    )
    .map((definition) => {
      const capabilities = manifestKeys(definition.manifest).manifest.capabilities;
      return {
        pluginId: definition.manifest.id,
        carrierId: capabilities && 'carrierId' in capabilities ? capabilities.carrierId : undefined,
      };
    })
    .filter(
      (entry): entry is { pluginId: string; carrierId: string } =>
        typeof entry.carrierId === 'string',
    );
  const configured = JSON.parse(legacyEnvBindings(env).OVO_CARRIER_ENV_BINDINGS ?? '{}') as Record<
    string,
    unknown
  >;
  const configuredIds = Object.keys(configured);
  const environmentCarrierId =
    configuredIds.length === 1 && installed.some((entry) => entry.carrierId === configuredIds[0])
      ? configuredIds[0]
      : configuredIds.length === 0 && installed.length === 1
        ? installed[0]!.carrierId
        : undefined;
  operations.inboundGateway.setInstalledCarrierPlugins(installed, environmentCarrierId);
}
