import { configError, inlineSecretErrors } from './config-guard.ts';
import type { PluginDefinition, PluginRow } from './define.ts';
import { manifestKeys, resolveGraph } from './graph.ts';
import { kindRuleErrors, unavailableReason } from './kind-rules.ts';
import { scopeErrors, type CompositionScope } from './scope.ts';

export type GraphIssueCode =
  | 'graph_invalid'
  | 'plugin_unavailable'
  | 'fixture_disabled'
  | 'scope_mismatch'
  | 'kind_rule'
  | 'secret_inline'
  | 'config_invalid';

export interface GraphIssue {
  code: GraphIssueCode;
  pluginId?: string;
  message: string;
}

export interface ValidateGraphOptions {
  scope?: CompositionScope;
  /** Keys the host or a parent composition provides; they count as satisfied. */
  parentKeys?: Iterable<string>;
  /** Fixture-kind plugins compose only when this is true (§3.8). */
  fixtures?: boolean;
}

/** Checks that need only the manifests: scope, runtime availability, fixtures and kind rules. */
function manifestIssues(
  definitions: readonly PluginDefinition[],
  catalog: readonly PluginDefinition[],
  opts: ValidateGraphOptions,
): GraphIssue[] {
  const issues: GraphIssue[] = scopeErrors(definitions, opts.scope).map((error) => ({
    code: 'scope_mismatch',
    ...error,
  }));
  for (const definition of definitions) {
    const pluginId = definition.manifest.id;
    const reason = unavailableReason(definition.manifest);
    if (reason)
      issues.push({
        code: 'plugin_unavailable',
        pluginId,
        message: `Plugin ${pluginId} is unavailable: ${reason}`,
      });
    if (manifestKeys(definition.manifest).manifest.kind === 'fixture' && !opts.fixtures)
      issues.push({
        code: 'fixture_disabled',
        pluginId,
        message: `Fixture plugin ${pluginId} composes only with fixtures enabled`,
      });
    for (const message of kindRuleErrors(definition, catalog))
      issues.push({ code: 'kind_rule', pluginId, message });
  }
  return issues;
}

/** Row-config checks: inline secrets (every mode) and the strict Ajv schema. */
function configIssues(
  ordered: readonly PluginDefinition[],
  configOf: (id: string) => Record<string, unknown>,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  for (const definition of ordered) {
    const pluginId = definition.manifest.id;
    const config = configOf(pluginId);
    for (const message of inlineSecretErrors(definition.manifest, config))
      issues.push({ code: 'secret_inline', pluginId, message });
    const error = configError(definition.manifest, config);
    if (error) issues.push({ code: 'config_invalid', pluginId, message: error });
  }
  return issues;
}

/**
 * Release validation (§3.5): resolve the graph and check scope, config and kind rules. It NEVER runs
 * `apply`, so engines and providers are never started during validation. Compose reports the first
 * issue; this returns them all.
 */
export function validateGraph(
  rows: PluginRow[],
  catalog: readonly PluginDefinition[],
  opts: ValidateGraphOptions = {},
): { ordered: PluginDefinition[]; issues: GraphIssue[] } {
  const known = rows.flatMap((row) =>
    catalog.filter((item) => item.manifest.id === row.id).slice(0, 1),
  );
  const issues = manifestIssues(known, catalog, opts);
  let ordered: PluginDefinition[];
  try {
    ordered = resolveGraph(rows, catalog, { parentKeys: opts.parentKeys });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ordered: [], issues: [...issues, { code: 'graph_invalid', message }] };
  }
  const configs = new Map(rows.map((row) => [row.id, row.config ?? {}]));
  issues.push(...configIssues(ordered, (id) => configs.get(id) ?? {}));
  return { ordered, issues };
}
