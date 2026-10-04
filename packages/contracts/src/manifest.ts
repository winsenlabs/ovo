import { z } from 'zod';
import { JsonSchema } from './agent.ts';
import type { CarrierCapabilities } from './carrier/capabilities.ts';
import { Cap, parseCapabilityEntry } from './capabilities/keys.ts';
import { Slot } from './selection.ts';
import type { SpeechCapabilities } from './speech/capabilities.ts';
import { UsageUnit } from './usage.ts';
import type { EngineCapabilities } from './voice/engine.ts';
import type { VadParams } from './voice/vad.ts';

const Version = z.string().regex(/^\d+\.\d+\.\d+$/);
const PluginScope = z.enum(['process', 'session']);

/** Contract version 1, unchanged. `normalizeManifest` upcasts it to kind 'infra'. */
export const ManifestV1 = z.object({
  id: z.string().min(1),
  version: Version,
  contractVersion: z.literal(1),
  scope: PluginScope,
  provides: z.array(z.string()),
  requires: z.array(z.string()).default([]),
  configSchema: JsonSchema.default({ type: 'object' }),
  secretFields: z.array(z.string()).default([]),
  ui: z.object({ label: z.string(), panel: z.string().optional() }).optional(),
});
export type ManifestV1 = z.infer<typeof ManifestV1>;

export const PLUGIN_KINDS = [
  'engine',
  'carrier',
  'stt',
  'tts',
  'llm',
  'vad',
  'turn-detector',
  'audio-filter',
  'text-filter',
  'voicemail',
  'behavior',
  'tool',
  'infra',
  'host',
  'console',
  'fixture',
] as const;
export const PluginKind = z.enum(PLUGIN_KINDS);
export type PluginKind = z.infer<typeof PluginKind>;

export interface LlmCapabilities {
  tools: boolean;
  streaming: boolean;
}
export type ManifestCapabilities =
  SpeechCapabilities | EngineCapabilities | CarrierCapabilities | VadParams | LlmCapabilities;

export const CONFORMANCE_KITS = [
  'stt@1',
  'tts@1',
  'llm@1',
  'carrier@1',
  'engine@1',
  'vad@1',
  'turn@1',
] as const;

/**
 * A capability key, optionally `${key}@${major}`. Only a trailing `@<digits>` is a major, and it must
 * be positive with no leading zero; keys such as `ovo.native-handlers:@scope/pkg@1.2.3` stay whole.
 */
const CapabilityEntry = z.string().regex(/^(?!.*@0\d*$)(?!.*@$)(?!@\d+$)\S+$/);

export const MeterDeclaration = z
  .object({
    key: z.string().min(1),
    unit: UsageUnit,
    label: z.string().min(1),
    role: z.enum(['carrier', 'stt', 'tts', 'llm']),
    /** Applies only when `binding.config[field]` is one of `in`. */
    when: z
      .object({ field: z.string().min(1), in: z.array(z.string()).min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type MeterDeclaration = z.infer<typeof MeterDeclaration>;

const UiField = z
  .object({
    widget: z
      .enum(['text', 'textarea', 'select', 'number', 'switch', 'secret', 'voice', 'model'])
      .optional(),
    label: z.string().optional(),
    help: z.string().optional(),
    group: z.string().optional(),
    advanced: z.boolean().optional(),
    order: z.number().optional(),
  })
  .strict();

const ManifestUi = z.object({
  label: z.string(),
  description: z.string().optional(),
  vendor: z.string().optional(),
  docsUrl: z.string().optional(),
  slot: Slot.optional(),
  order: z.number().optional(),
  fields: z.record(z.string(), UiField).optional(),
});

const isObject = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Kinds that must declare provider, capabilities, runtime.egressHosts and conformance (§3.1). */
export const DECLARED_KINDS: readonly PluginKind[] = ['engine', 'carrier', 'stt', 'tts', 'llm'];
/** Kinds whose manifest must declare meters. */
export const METERED_KINDS: readonly PluginKind[] = ['carrier', 'stt', 'tts', 'llm'];
/** Kinds that must declare a provider. */
export const PROVIDER_KINDS: readonly PluginKind[] = [...DECLARED_KINDS, 'vad', 'turn-detector'];

export const ManifestV2 = z
  .object({
    id: z.string().min(1),
    version: Version,
    contractVersion: z.literal(2),
    scope: PluginScope,
    kind: PluginKind,
    /** Matches `binding.provider`. */
    provider: z.string().min(1).optional(),
    provides: z.array(CapabilityEntry),
    requires: z.array(CapabilityEntry).default([]),
    optional: z.array(CapabilityEntry).default([]),
    /** Capability key → plugin id from the same package, pinned at this version (engines only, §2.2). */
    companions: z.record(z.string().min(1), z.string().min(1)).optional(),
    configSchema: JsonSchema.default({ type: 'object' }),
    /** Non-secret binding config: console SchemaForm + Ajv at binding create and release. */
    bindingSchema: JsonSchema.optional(),
    /** JSON pointers that MUST hold {credentialRef:{credentialId}}. */
    secretFields: z.array(z.string()).default([]),
    capabilities: z
      .custom<ManifestCapabilities>(isObject, 'capabilities must be an object')
      .optional(),
    meters: z.array(MeterDeclaration).optional(),
    runtime: z
      .object({
        native: z.literal('glibc').optional(),
        egressHosts: z.array(z.string().min(1)),
        modelLicences: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .optional(),
    conformance: z.array(z.enum(CONFORMANCE_KITS)).optional(),
    ui: ManifestUi.optional(),
  })
  .superRefine((manifest, issue) => {
    const fail = (path: string, message: string) =>
      issue.addIssue({ code: 'custom', path: [path], message });
    if (PROVIDER_KINDS.includes(manifest.kind) && !manifest.provider)
      fail('provider', `kind ${manifest.kind} must declare provider`);
    if (DECLARED_KINDS.includes(manifest.kind)) {
      if (!manifest.capabilities)
        fail('capabilities', `kind ${manifest.kind} must declare capabilities`);
      if (!manifest.runtime)
        fail('runtime', `kind ${manifest.kind} must declare runtime.egressHosts`);
      if (!manifest.conformance?.length)
        fail('conformance', `kind ${manifest.kind} must declare conformance`);
    }
    if (METERED_KINDS.includes(manifest.kind) && !manifest.meters?.length)
      fail('meters', `kind ${manifest.kind} must declare meters`);
    if (manifest.companions && manifest.kind !== 'engine')
      fail('companions', 'companions are allowed only on engine plugins');
  });
export type ManifestV2 = z.infer<typeof ManifestV2>;
export type ManifestV2Input = z.input<typeof ManifestV2>;

/** Contract version 1 (unchanged) or 2 (§3.1). */
export const Manifest = z.discriminatedUnion('contractVersion', [ManifestV1, ManifestV2]);
export type Manifest = z.infer<typeof Manifest>;
export type ManifestInput = z.input<typeof Manifest>;

/**
 * The v2 view of any manifest. v1 becomes kind 'infra' with `optional: []`. Declaring secretFields
 * adds `ovo.secret-resolver` to `optional` (§3.6).
 */
export function normalizeManifest(manifest: Manifest): ManifestV2 {
  const v2: ManifestV2 =
    manifest.contractVersion === 2
      ? manifest
      : {
          id: manifest.id,
          version: manifest.version,
          contractVersion: 2,
          scope: manifest.scope,
          kind: 'infra',
          provides: manifest.provides,
          requires: manifest.requires,
          optional: [],
          configSchema: manifest.configSchema,
          secretFields: manifest.secretFields,
          ...(manifest.ui ? { ui: { label: manifest.ui.label } } : {}),
        };
  const declared = [...v2.requires, ...v2.optional].map((entry) => parseCapabilityEntry(entry).key);
  if (!v2.secretFields.length || declared.includes(Cap.secrets)) return v2;
  return { ...v2, optional: [...v2.optional, Cap.secrets] };
}
