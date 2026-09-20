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

const ALL_MODES = ['announcement', 'faq', 'context', 'agent'] as const;

export const coreConsoleExtensions: readonly ConsoleExtension[] = Object.freeze([
  {
    id: 'agent-identity',
    ownerPluginId: '@winsendotai/ovo-console-agent-identity',
    label: 'Agent identity',
    version: '0.1.0',
    forms: [
      {
        id: 'identity',
        title: 'Identity and locale',
        modes: ALL_MODES,
        fields: [
          { path: 'name', label: 'Agent name', kind: 'text' },
          { path: 'language', label: 'Language', kind: 'text', help: 'BCP 47 language tag.' },
          {
            path: 'locale',
            label: 'Locale',
            kind: 'text',
            help: 'Formatting locale for approved values.',
          },
          {
            path: 'timezone',
            label: 'Timezone',
            kind: 'text',
            help: 'IANA timezone used for date rendering.',
          },
        ],
      },
    ],
    panels: [],
  },
  {
    id: 'announcement-mode',
    ownerPluginId: '@winsendotai/ovo-console-announcement',
    label: 'Announcement configuration',
    version: '0.1.0',
    forms: [
      {
        id: 'announcement-message',
        title: 'Approved message',
        modes: ['announcement'],
        fields: [
          {
            path: 'message',
            label: 'Message template',
            kind: 'textarea',
            help: 'Variables must be declared in the JSON Schema.',
          },
          { path: 'variables', label: 'Variable JSON Schema', kind: 'json' },
        ],
      },
    ],
    panels: [],
  },
  {
    id: 'faq-mode',
    ownerPluginId: '@winsendotai/ovo-console-faq',
    label: 'FAQ configuration',
    version: '0.1.0',
    forms: [
      {
        id: 'faq-policy',
        title: 'Deterministic matching policy',
        modes: ['faq'],
        fields: [
          { path: 'faqThreshold', label: 'Minimum match score', kind: 'number', min: 0, max: 1 },
          { path: 'faqMargin', label: 'Required winner margin', kind: 'number', min: 0, max: 1 },
          { path: 'clarification', label: 'Clarification response', kind: 'textarea' },
        ],
      },
    ],
    panels: [],
  },
  {
    id: 'context-mode',
    ownerPluginId: '@winsendotai/ovo-console-context',
    label: 'Supplied context',
    version: '0.1.0',
    forms: [
      {
        id: 'context-policy',
        title: 'Bounded supplied context',
        modes: ['context', 'agent'],
        fields: [
          { path: 'context', label: 'Approved context', kind: 'textarea' },
          { path: 'contextBudget', label: 'Context budget', kind: 'number', min: 1, max: 100000 },
          { path: 'uncertainty', label: 'Uncertainty response', kind: 'textarea' },
        ],
      },
    ],
    panels: [],
  },
  {
    id: 'processing-speech',
    ownerPluginId: '@winsendotai/ovo-console-processing-speech',
    label: 'Processing speech',
    version: '0.1.0',
    forms: [
      {
        id: 'processing-speech',
        title: 'Processing phrases',
        modes: ALL_MODES,
        fields: [
          { path: 'processing.initial', label: 'Initial acknowledgment', kind: 'textarea' },
          { path: 'processing.progress', label: 'Delayed progress phrase', kind: 'textarea' },
          {
            path: 'processing.progressAfterMs',
            label: 'Progress delay (ms)',
            kind: 'number',
            min: 1,
          },
          {
            path: 'processing.maxProgress',
            label: 'Maximum progress messages',
            kind: 'number',
            min: 0,
            max: 3,
          },
          { path: 'processing.failure', label: 'Failure wording', kind: 'textarea' },
        ],
      },
    ],
    panels: [],
  },
  {
    id: 'operations-evidence',
    ownerPluginId: '@winsendotai/ovo-console-operations',
    label: 'Operations evidence',
    version: '0.1.0',
    forms: [],
    panels: [
      {
        id: 'recordings',
        title: 'Recordings',
        placement: 'evidence',
        state: 'backend-required',
        description: 'Recording state and alignment require call artifact APIs.',
      },
      {
        id: 'performance',
        title: 'Performance',
        placement: 'evidence',
        state: 'not-implemented',
        description: 'No aggregate cohort or percentile endpoint exists in the management API.',
      },
      {
        id: 'infrastructure',
        title: 'Infrastructure',
        placement: 'evidence',
        state: 'not-implemented',
        description: 'No worker, queue, quota, or capacity endpoint exists in the management API.',
      },
    ],
  },
]);

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
