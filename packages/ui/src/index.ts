import type { AgentConfig, Manifest } from '@winsendotai/ovo-contracts';
import {
  compose,
  definePlugin,
  type PluginDefinition,
  type PluginRow,
} from '@winsendotai/ovo-runtime';

export const CONSOLE_EXTENSION_REGISTRY = 'ovo.console-extensions';

export type AgentConfigPath = keyof AgentConfig | `processing.${keyof AgentConfig['processing']}`;
export type ConsoleField = Readonly<{
  path: AgentConfigPath;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'switch' | 'json';
  help?: string;
  min?: number;
  max?: number;
}>;

export type ConsoleForm = Readonly<{
  id: string;
  title: string;
  modes: readonly AgentConfig['mode'][];
  fields: readonly ConsoleField[];
}>;

export type ConsolePanel = Readonly<{
  id: string;
  title: string;
  placement: 'studio' | 'integration' | 'evidence';
  state: 'available' | 'backend-required' | 'not-implemented';
  description: string;
}>;

export type ConsoleExtension = Readonly<{
  id: string;
  ownerPluginId: string;
  label: string;
  version: string;
  forms: readonly ConsoleForm[];
  panels: readonly ConsolePanel[];
}>;

function freezeExtension(extension: ConsoleExtension): ConsoleExtension {
  if (!extension.id || !extension.ownerPluginId || !extension.label)
    throw new Error('Console extension metadata is required');
  const formIds = extension.forms.map((form) => form.id);
  const panelIds = extension.panels.map((panel) => panel.id);
  if (new Set(formIds).size !== formIds.length || new Set(panelIds).size !== panelIds.length) {
    throw new Error(`Duplicate console surface in ${extension.id}`);
  }
  return Object.freeze({
    ...extension,
    forms: Object.freeze(
      extension.forms.map((form) =>
        Object.freeze({
          ...form,
          modes: Object.freeze([...form.modes]),
          fields: Object.freeze(form.fields.map((field) => Object.freeze({ ...field }))),
        }),
      ),
    ),
    panels: Object.freeze(extension.panels.map((panel) => Object.freeze({ ...panel }))),
  });
}

export class ConsoleExtensionRegistry {
  readonly #extensions = new Map<string, ConsoleExtension>();

  register(extension: ConsoleExtension): () => void {
    const safe = freezeExtension(extension);
    if (this.#extensions.has(safe.id)) throw new Error(`Duplicate console extension: ${safe.id}`);
    this.#extensions.set(safe.id, safe);
    return () => this.#extensions.delete(safe.id);
  }

  list(): readonly ConsoleExtension[] {
    return Object.freeze([...this.#extensions.values()]);
  }
}

export function createConsoleExtensionRegistryPlugin(): PluginDefinition {
  return definePlugin(
    {
      id: '@winsendotai/ovo-console-extension-registry',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      provides: [CONSOLE_EXTENSION_REGISTRY],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
      ui: { label: 'Console extension registry' },
    },
    (ctx) => {
      ctx.provide(CONSOLE_EXTENSION_REGISTRY, new ConsoleExtensionRegistry());
    },
  );
}

export function createConsoleExtensionPlugin(extension: ConsoleExtension): PluginDefinition {
  const safe = freezeExtension(extension);
  const service = `ovo.console-extension.${safe.id}`;
  const manifest: Manifest = {
    id: safe.ownerPluginId,
    version: safe.version,
    contractVersion: 1,
    scope: 'process',
    provides: [service],
    requires: [CONSOLE_EXTENSION_REGISTRY],
    configSchema: { type: 'object', additionalProperties: false },
    secretFields: [],
    ui: { label: safe.label, panel: safe.panels[0]?.id },
  };
  return definePlugin(manifest, (ctx) => {
    const registry = ctx.get(CONSOLE_EXTENSION_REGISTRY) as ConsoleExtensionRegistry | undefined;
    if (!registry) throw new Error('Console extension registry is unavailable');
    const unregister = registry.register(safe);
    ctx.effect(() => unregister);
    ctx.provide(service, { id: safe.id, registered: true });
  });
}

import { coreConsoleExtensions } from './core-extensions';
export { coreConsoleExtensions } from './core-extensions';

export const coreConsolePlugins = Object.freeze(
  coreConsoleExtensions.map(createConsoleExtensionPlugin),
);

/** Compose extensions through the same Cordis lifecycle used by runtime capabilities. */
export async function loadConsoleExtensions(
  extraPlugins: readonly PluginDefinition[] = [],
): Promise<readonly ConsoleExtension[]> {
  const registryPlugin = createConsoleExtensionRegistryPlugin();
  const catalog = [registryPlugin, ...coreConsolePlugins, ...extraPlugins];
  const rows: PluginRow[] = catalog.map((plugin) => ({ id: plugin.manifest.id }));
  const composition = await compose(rows, catalog);
  try {
    const registry = composition.ctx.get(CONSOLE_EXTENSION_REGISTRY) as
      ConsoleExtensionRegistry | undefined;
    if (!registry) throw new Error('Console extension registry did not compose');
    return registry.list();
  } finally {
    await composition.dispose();
  }
}
