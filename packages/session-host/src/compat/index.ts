import type { CompatIssue, CompatStage } from '@winsendotai/ovo-contracts';
import { pluginNotInstalled } from './plugin-not-installed.ts';
import { pluginVersionNotInstalled } from './plugin-version-not-installed.ts';
import { pluginUnavailable } from './plugin-unavailable.ts';
import { bindingMissing } from './binding-missing.ts';
import { bindingPluginMismatch } from './binding-plugin-mismatch.ts';
import { bindingSchemaInvalid } from './binding-schema-invalid.ts';
import { secretInline } from './secret-inline.ts';
import { formatUnreachable } from './format-unreachable.ts';
import { sttFrameSize } from './stt-frame-size.ts';
import { languageUnsupported } from './language-unsupported.ts';
import { modeRequiresLlm } from './mode-requires-llm.ts';
import { modeLlmUnused } from './mode-llm-unused.ts';
import { turnSignalMissing } from './turn-signal-missing.ts';
import { playbackEvidenceInsufficient } from './playback-evidence-insufficient.ts';
import { engineCapabilityMissing } from './engine-capability-missing.ts';
import { amdUnsupported } from './amd-unsupported.ts';
import { meterUncovered } from './meter-uncovered.ts';
import { runtimeIncompatible } from './runtime-incompatible.ts';
import { licenceUnaccepted } from './licence-unaccepted.ts';
import { fixtureUnavailable } from './fixture-unavailable.ts';
import { mcpToolRemoved } from './mcp-tool-removed.ts';
import { terminationUnsupported } from './termination-unsupported.ts';
import { legacyReleaseUnpinned } from './legacy-release-unpinned.ts';
import type { CompatInput, CompatRule } from './types.ts';
import { legacySelections } from '../legacy-session-selections.ts';

export type { CompatInput } from './types.ts';

const RELEASE_RULES: readonly CompatRule[] = [
  pluginNotInstalled,
  pluginVersionNotInstalled,
  bindingMissing,
  bindingPluginMismatch,
  bindingSchemaInvalid,
  secretInline,
  mcpToolRemoved,
];
const ADMISSION_RULES: readonly CompatRule[] = [
  pluginUnavailable,
  formatUnreachable,
  sttFrameSize,
  languageUnsupported,
  modeRequiresLlm,
  modeLlmUnused,
  turnSignalMissing,
  playbackEvidenceInsufficient,
  engineCapabilityMissing,
  amdUnsupported,
  meterUncovered,
  runtimeIncompatible,
  licenceUnaccepted,
  fixtureUnavailable,
  terminationUnsupported,
  legacyReleaseUnpinned,
];

/** Pure compatibility evaluation. The caller decides whether a stage's errors block the action. */
export function validateSelections(input: CompatInput, stage: CompatStage): CompatIssue[] {
  const rules = stage === 'release' ? RELEASE_RULES : [...RELEASE_RULES, ...ADMISSION_RULES];
  let selections = input.selections;
  if (!selections || !Object.keys(selections).length) {
    try {
      selections = legacySelections({
        release: { config: input.config, providerBindings: input.legacyProviderBindings },
        registry: input.registry,
        defaults: input.defaults,
      });
    } catch {
      // Missing required roles are reported by admission rules below.
    }
  }
  const effective: CompatInput = {
    ...input,
    bindings: {
      ...Object.fromEntries(
        Object.entries(input.legacyProviderBindings ?? {}).map(([id, binding]) => [
          id,
          { pluginId: binding.pluginId, provider: binding.provider, config: binding.config ?? {} },
        ]),
      ),
      ...input.bindings,
    },
    selections:
      stage !== 'release' && input.actualCarrier
        ? { ...selections, carrier: input.actualCarrier }
        : selections,
  };
  return rules.flatMap((rule) =>
    rule === legacyReleaseUnpinned ? rule(input, stage) : rule(effective, stage),
  );
}
