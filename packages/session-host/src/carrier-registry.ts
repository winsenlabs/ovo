import type {
  CarrierCapabilities,
  CarrierControlFactory,
  Release,
  ResolvedBinding,
} from '@winsendotai/ovo-contracts';
import { PluginPinError } from '@winsendotai/ovo-runtime';

export interface InstalledCarrierControl {
  version: string;
  factory: CarrierControlFactory;
}

export interface SelectedCarrier {
  carrierId: string;
  bindingId: string;
  control: CarrierControlFactory;
  capabilities: CarrierCapabilities;
  binding: ResolvedBinding;
}

export interface InboundCarrierRoute {
  carrierPluginId?: string | null;
  carrierBindingId?: string | null;
}

/** Process-scope carrier controls are selected by release pin or inbound route, never by a global default. */
export class CarrierRegistry {
  constructor(
    private readonly controls: ReadonlyMap<string, InstalledCarrierControl>,
    private readonly bindings: (id: string, carrierId?: string) => Promise<ResolvedBinding>,
    private readonly envPluginId?: string,
  ) {}

  async forRelease(release: Pick<Release, 'selections'>): Promise<SelectedCarrier> {
    const selected = release.selections?.carrier;
    if (!selected) throw new Error('A carrier selection is required');
    const installed = this.controls.get(selected.pluginId);
    if (!installed)
      throw new PluginPinError(
        'plugin_not_installed',
        `Carrier control is not installed: ${selected.pluginId}`,
      );
    if (installed.version.split('.')[0] !== selected.version.split('.')[0])
      throw new PluginPinError(
        'plugin_version_not_installed',
        `${selected.pluginId}@${selected.version} is not installed`,
      );
    return this.select(selected.pluginId, selected.bindingId ?? 'env');
  }

  async forInboundRoute(route: InboundCarrierRoute): Promise<SelectedCarrier> {
    const pluginId = route.carrierPluginId ?? this.envPluginId;
    if (!pluginId) throw new Error('Inbound carrier has no selected plugin');
    return this.select(pluginId, route.carrierBindingId ?? 'env');
  }

  private async select(pluginId: string, bindingId: string): Promise<SelectedCarrier> {
    const installed = this.controls.get(pluginId);
    if (!installed) throw new Error(`Carrier control is not installed: ${pluginId}`);
    const control = installed.factory;
    const carrierId = control.capabilities.carrierId;
    const binding = await this.bindings(bindingId, carrierId);
    if (binding.pluginId !== pluginId)
      throw new Error(`Carrier binding ${bindingId} is for ${binding.pluginId}, not ${pluginId}`);
    return { carrierId, bindingId, control, capabilities: control.capabilities, binding };
  }
}
