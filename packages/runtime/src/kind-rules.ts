import { CAP_PREFIXES, Cap, type Manifest } from '@winsendotai/ovo-contracts';
import type { PluginDefinition } from './define.ts';
import { manifestKeys } from './graph.ts';

/** Engines never reach tools directly; execution speaks through the engine's `ovo.speech` (§3.8). */
export function isEngineToolKey(key: string): boolean {
  return key === Cap.execution || key.startsWith(CAP_PREFIXES.toolConnector);
}

type GlibcProbe = () => string | undefined;

interface ProcessReport {
  getReport?: () => { header?: { glibcVersionRuntime?: string } };
}

const defaultProbe: GlibcProbe = () => {
  const report = (globalThis as { process?: { report?: ProcessReport } }).process?.report;
  try {
    return report?.getReport?.()?.header?.glibcVersionRuntime || undefined;
  } catch {
    return undefined;
  }
};

let probe: GlibcProbe = defaultProbe;
let cached: { value: string | undefined } | undefined;

/** The glibc version of this process, from `process.report` (read once and cached). */
export function glibcVersion(): string | undefined {
  cached ??= { value: probe() };
  return cached.value;
}

/** Tests and hosts may replace the probe; `undefined` restores the `process.report` probe. */
export function setGlibcProbe(next: GlibcProbe | undefined): void {
  probe = next ?? defaultProbe;
  cached = undefined;
}

/** Why a plugin cannot run in this process, or undefined. Missing glibc marks it unavailable; it never throws. */
export function unavailableReason(manifest: Manifest): string | undefined {
  if (manifest.contractVersion !== 2 || manifest.runtime?.native !== 'glibc') return undefined;
  return glibcVersion() ? undefined : `${manifest.id} needs glibc, and this runtime has none`;
}

/** Compose-time kind rules (§3.8). Returns one message per broken rule. */
export function kindRuleErrors(
  definition: PluginDefinition,
  catalog: readonly PluginDefinition[],
): string[] {
  const { manifest, requires, optional } = manifestKeys(definition.manifest);
  const errors: string[] = [];
  if (manifest.kind !== 'engine') return errors;
  for (const entry of [...requires, ...optional])
    if (isEngineToolKey(entry.key))
      errors.push(`engine-tool-access: engine ${manifest.id} may not declare ${entry.key}`);
  for (const [key, companionId] of Object.entries(manifest.companions ?? {})) {
    const found = catalog.some(
      (item) => item.manifest.id === companionId && item.manifest.version === manifest.version,
    );
    if (!found)
      errors.push(
        `Engine ${manifest.id} companion ${companionId}@${manifest.version} for ${key} is not installed`,
      );
  }
  return errors;
}
