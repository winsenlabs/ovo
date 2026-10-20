import type { RouteLines } from './ids.ts';
import type { RoutingChange, RoutingDiffInput } from './diff-model.ts';
import {
  changedFields,
  createChanges,
  indexBy,
  isSnapshot,
  joinNames,
  same,
  stripReleases,
  type AddChange,
} from './diff-util.ts';
import { diffNodes } from './diff-nodes.ts';
import { diffPolicies } from './diff-policies.ts';
import type { RoutingPointDraft } from './point.ts';
import type { RoutingNode } from './tree.ts';

/** The languages whose line differs, for a sentence ("hi, ta"). */
function lineLanguages(before: RouteLines | undefined, after: RouteLines | undefined): string {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return joinNames([...keys].filter((key) => before?.[key] !== after?.[key]).sort());
}

function diffLines(
  add: AddChange,
  key: string,
  path: (string | number)[],
  before: RouteLines | undefined,
  after: RouteLines | undefined,
): void {
  if (same(before, after)) return;
  if (!before) add('lines', 'added', key, path, `${key} added`, { after });
  else if (!after) add('lines', 'removed', key, path, `${key} removed`, { before });
  else
    add('lines', 'changed', key, path, `${key} changed (${lineLanguages(before, after)})`, {
      before,
      after,
    });
}

function diffPoint(add: AddChange, b: RoutingPointDraft, a: RoutingPointDraft): void {
  for (const field of ['name', 'description', 'root'] as const)
    if (!same(b[field], a[field]))
      add(
        'point',
        'changed',
        field,
        [field],
        `${field[0]!.toUpperCase()}${field.slice(1)} changed from ${JSON.stringify(b[field] ?? '')} to ${JSON.stringify(a[field] ?? '')}`,
        { before: b[field], after: a[field] },
      );
  for (const field of ['router', 'defaultTarget'] as const) {
    const label = field === 'router' ? 'Router agent' : 'Default target';
    if (b[field].agentId !== a[field].agentId)
      add(
        'agent',
        'changed',
        field,
        [field],
        `${label} changed from ${b[field].agentId} to ${a[field].agentId}`,
        { before: b[field], after: a[field] },
      );
    else if (!same(b[field].release, a[field].release))
      add('agent', 'changed', field, [field], `${label} ${a[field].agentId} release changed`, {
        before: b[field].release,
        after: a[field].release,
      });
  }
  if (b.language.default !== a.language.default)
    add(
      'language',
      'changed',
      'default language',
      ['language', 'default'],
      `Default language changed from ${b.language.default} to ${a.language.default}`,
      { before: b.language.default, after: a.language.default },
    );
  const added = a.language.allowed.filter((l) => !b.language.allowed.includes(l));
  const removed = b.language.allowed.filter((l) => !a.language.allowed.includes(l));
  if (added.length || removed.length)
    add(
      'language',
      'changed',
      'allowed languages',
      ['language', 'allowed'],
      `Allowed languages${added.length ? `: added ${joinNames(added)}` : ''}${removed.length ? `${added.length ? ';' : ':'} removed ${joinNames(removed)}` : ''}`,
      { before: b.language.allowed, after: a.language.allowed },
    );
  diffLines(add, 'Greeting', ['greeting'], b.greeting, a.greeting);
  diffLines(add, 'Connecting line', ['connecting'], b.connecting, a.connecting);
  if (!same(b.idle, a.idle))
    add('lines', 'changed', 'idle prompts', ['idle'], 'Idle prompts changed', {
      before: b.idle,
      after: a.idle,
    });
  if (!same(b.limits, a.limits))
    add(
      'limits',
      'changed',
      'routing limits',
      ['limits'],
      `Routing limits changed (${joinNames(changedFields(b.limits, a.limits))})`,
      { before: b.limits, after: a.limits },
    );
}

/**
 * What changed between two drafts or snapshots, as a deterministic list of changes. `before`
 * absent: everything in `after` is an addition. A draft compared with a snapshot ignores agent
 * releases (a draft's `latest` against a snapshot's pins); two snapshots compare them.
 */
export function routingDiff(
  before: RoutingDiffInput | undefined,
  after: RoutingDiffInput,
): RoutingChange[] {
  const { list, add } = createChanges();
  const mixed = before !== undefined && isSnapshot(before) !== isSnapshot(after);
  const prep = <T extends RoutingDiffInput>(input: T): T =>
    mixed ? (stripReleases(input) as T) : input;
  const b = before && prep(before);
  const a = prep(after);
  if (b) diffPoint(add, b, a);
  else
    add('point', 'added', 'routing point', [], `Routing point ${JSON.stringify(a.name)} added`, {
      after: a.name,
    });
  diffNodes(add, b?.nodes ?? [], a.nodes);
  diffPolicies(add, b, a);
  return list;
}
