import type { Manifest } from '@winsendotai/ovo-contracts';

/** Which plugin's `apply` threw: what a host needs to say "the stt plugin failed to start". */
export interface PluginFailure {
  pluginId: string;
  kind?: string;
  provider?: string;
}

// Keyed by the thrown object, so the error itself is neither wrapped nor mutated: callers that
// match on its class or message see exactly what the plugin threw.
const failures = new WeakMap<object, PluginFailure>();

export function recordPluginFailure(error: unknown, manifest: Manifest): void {
  if (!error || typeof error !== 'object' || failures.has(error)) return;
  const { id, kind, provider } = manifest as Manifest & { kind?: string; provider?: string };
  failures.set(error, {
    pluginId: id,
    ...(kind ? { kind } : {}),
    ...(provider ? { provider } : {}),
  });
}

/** The plugin whose start threw `error`, or one of its causes; undefined for any other failure. */
export function pluginFailureOf(error: unknown, depth = 0): PluginFailure | undefined {
  if (!error || typeof error !== 'object' || depth > 5) return undefined;
  const found = failures.get(error);
  if (found) return found;
  if (error instanceof AggregateError)
    for (const inner of error.errors) {
      const nested = pluginFailureOf(inner, depth + 1);
      if (nested) return nested;
    }
  return pluginFailureOf((error as { cause?: unknown }).cause, depth + 1);
}
