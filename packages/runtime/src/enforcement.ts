import type { Manifest } from '@winsendotai/ovo-contracts';

export type EnforcementMode = 'warn' | 'enforce';
export type ViolationKind =
  | 'read-undeclared'
  | 'provide-undeclared'
  | 'egress-denied'
  | 'engine-tool-access'
  /** Reached a raw Cordis member (plugin, inject, root, scope, …) that bypasses the manifest. */
  | 'context-escape';

export interface PluginViolation {
  pluginId: string;
  pluginVersion: string;
  kind: ViolationKind;
  key: string;
  mode: EnforcementMode;
  message: string;
}

export type ViolationSink = (violation: PluginViolation) => void;

/** Kinds that throw in every mode (§3.3). */
const ALWAYS_THROWS: ReadonlySet<ViolationKind> = new Set(['egress-denied', 'engine-tool-access']);

let sink: ViolationSink | undefined;

/** The runtime never writes files itself; a host or test setup installs a sink (§3.7). */
export function setViolationSink(next: ViolationSink | undefined): void {
  sink = next;
}

export function getViolationSink(): ViolationSink | undefined {
  return sink;
}

export class PluginViolationError extends Error {
  constructor(readonly violation: PluginViolation) {
    super(violation.message);
    this.name = 'PluginViolationError';
  }
}

function environmentMode(): EnforcementMode | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.OVO_PLUGIN_ENFORCEMENT;
  return value === 'enforce' || value === 'warn' ? value : undefined;
}

/** v2 manifests always enforce. v1 uses the explicit option, then OVO_PLUGIN_ENFORCEMENT, then warn. */
export function enforcementMode(manifest: Manifest, override?: EnforcementMode): EnforcementMode {
  if (manifest.contractVersion === 2) return 'enforce';
  return override ?? environmentMode() ?? 'warn';
}

export interface ViolationLog {
  readonly violations: readonly PluginViolation[];
  /** Records, reports to the sink, and throws when the mode or kind requires it. */
  report(violation: Omit<PluginViolation, 'message'> & { message?: string }): void;
}

export function createViolationLog(): ViolationLog {
  const violations: PluginViolation[] = [];
  return {
    violations,
    report(input) {
      const violation: PluginViolation = Object.freeze({
        ...input,
        message:
          input.message ??
          `${input.kind}: plugin ${input.pluginId}@${input.pluginVersion} touched ${input.key}`,
      });
      violations.push(violation);
      try {
        sink?.(violation);
      } catch {
        // A failing sink must never change plugin behavior.
      }
      if (violation.mode === 'enforce' || ALWAYS_THROWS.has(violation.kind))
        throw new PluginViolationError(violation);
    },
  };
}
