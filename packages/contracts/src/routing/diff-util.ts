import { canonicalJson, compareCodeUnits } from '../canonical-json.ts';
import type { RoutingChange, RoutingChangeArea, RoutingDiffInput } from './diff-model.ts';
import type { RoutingReleaseSnapshot } from './point.ts';
import type { RoutingPath } from './tree.ts';

/** Helpers of `routingDiff`; not part of the package surface. */
export type AddChange = (
  area: RoutingChangeArea,
  op: RoutingChange['op'],
  key: string,
  path: RoutingPath,
  summary: string,
  values?: { before?: unknown; after?: unknown },
) => void;

export function createChanges(): { list: RoutingChange[]; add: AddChange } {
  const list: RoutingChange[] = [];
  const add: AddChange = (area, op, key, path, summary, values = {}) => {
    list.push({
      area,
      op,
      key,
      path,
      summary,
      ...(values.before === undefined ? {} : { before: values.before }),
      ...(values.after === undefined ? {} : { after: values.after }),
    });
  };
  return { list, add };
}

export const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** Top-level fields whose values differ, sorted. */
export function changedFields(before: object, after: object): string[] {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((field) => !same(a[field], b[field]))
    .sort(compareCodeUnits);
}

/** Items by a string key (the first of a duplicate wins), with their index. */
export function indexBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, { item: T; index: number }> {
  const found = new Map<string, { item: T; index: number }>();
  items.forEach((item, index) => {
    const k = key(item);
    if (!found.has(k)) found.set(k, { item, index });
  });
  return found;
}

/**
 * Drops the `release` of every agent reference, so a draft (`latest` refs) can be compared with a
 * snapshot (pinned refs) without every agent reading as changed. The pins are shown separately.
 */
export function stripReleases(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripReleases);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const entries = Object.entries(object).filter(
    ([key]) => !(key === 'release' && typeof object.agentId === 'string'),
  );
  return Object.fromEntries(entries.map(([key, child]) => [key, stripReleases(child)]));
}

export const isSnapshot = (input: RoutingDiffInput): input is RoutingReleaseSnapshot =>
  'schemaVersion' in input;

export const joinNames = (items: readonly string[]): string => items.join(', ');
