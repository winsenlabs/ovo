import type {
  AgentConfig,
  CompatCode,
  CompatIssue,
  CompatStage,
  ReleaseSelection,
  ReleaseSelections,
} from '@winsendotai/ovo-contracts';
import type { PluginRegistry } from '@winsendotai/ovo-runtime';
import { PluginPinError } from '@winsendotai/ovo-runtime';
import type { SessionDefaults, NormalizationBinding } from '../normalize.ts';

export interface CompatInput {
  config: AgentConfig;
  selections?: ReleaseSelections;
  /** Carrier resolved from the actual inbound route, which can differ from release selection. */
  actualCarrier?: ReleaseSelection;
  /** Sources used to derive selections on pre-v2 releases before live validation. */
  defaults?: SessionDefaults;
  legacyProviderBindings?: Readonly<
    Record<
      string,
      NormalizationBinding & {
        config?: Record<string, unknown>;
        credentialId?: string;
        updatedAt?: string;
      }
    >
  >;
  registry: PluginRegistry;
  bindings?: Readonly<
    Record<string, { pluginId?: string | null; provider?: string; config: Record<string, unknown> }>
  >;
  carrierFrameMs?: number;
  turnStrategy?: 'provider' | 'vad-timeout' | 'smart-turn' | 'stt';
  amd?: boolean;
  /** True if the worker image supports native glibc plugins. */
  glibc?: boolean;
  acceptedLicences?: readonly string[];
  priceCards?: Readonly<Record<string, unknown>>;
  fixturePluginIds?: readonly string[];
  fixtureTemplatePluginIds?: readonly string[];
  discoveredMcpTools?: readonly {
    connectionId: string;
    remoteName: string;
    removedAt?: string | null;
  }[];
}

export type CompatRule = (input: CompatInput, stage: CompatStage) => CompatIssue[];

export function issue(
  code: CompatCode,
  stage: CompatStage,
  message: string,
  extra: Partial<CompatIssue> = {},
  severity: CompatIssue['severity'] = 'error',
): CompatIssue {
  return { code, severity, stage, message, ...extra };
}

export function selected(input: CompatInput) {
  return Object.entries(input.selections ?? {}).filter(
    (entry): entry is [string, NonNullable<(typeof entry)[1]>] => !!entry[1],
  );
}

export function resolved(input: CompatInput) {
  return selected(input).flatMap(([slot, choice]) => {
    try {
      return [
        {
          slot,
          choice,
          definition: input.registry.resolvePin(choice.pluginId, choice.version).definition,
        },
      ];
    } catch {
      return [];
    }
  });
}

export function pinFailures(
  input: CompatInput,
  code: 'plugin_version_not_installed' | 'plugin_unavailable',
  stage: CompatStage,
): CompatIssue[] {
  return selected(input).flatMap(([slot, choice]) => {
    if (!input.registry.get(choice.pluginId)) return [];
    try {
      input.registry.resolvePin(choice.pluginId, choice.version);
      return [];
    } catch (error) {
      return error instanceof PluginPinError && error.code === code
        ? [issue(code, stage, error.message, { slot: slot as never, pluginId: choice.pluginId })]
        : [];
    }
  });
}
