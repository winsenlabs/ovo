import type { Slot } from './selection.ts';

/** Compatibility rule codes (§4.5). One rule per file lives in `session-host/src/compat`. */
export const COMPAT_CODES = [
  'plugin_not_installed',
  'plugin_version_not_installed',
  'plugin_unavailable',
  'binding_missing',
  'binding_plugin_mismatch',
  'binding_schema_invalid',
  'secret_inline',
  'format_unreachable',
  'stt_frame_size',
  'language_unsupported',
  'mode_requires_llm',
  'mode_llm_unused',
  'turn_signal_missing',
  'playback_evidence_insufficient',
  'engine_capability_missing',
  'amd_unsupported',
  'meter_uncovered',
  'runtime_incompatible',
  'licence_unaccepted',
  'fixture_unavailable',
  'mcp_tool_removed',
  'termination_unsupported',
  'legacy_release_unpinned',
] as const;
export type CompatCode = (typeof COMPAT_CODES)[number];

/** `release` blocks release creation, `live` blocks live admission, `test` applies to fixture calls. */
export type CompatStage = 'release' | 'live' | 'test';

export interface CompatIssue {
  code: CompatCode;
  severity: 'error' | 'warning';
  stage: CompatStage;
  slot?: Slot;
  pluginId?: string;
  field?: string;
  message: string;
}
