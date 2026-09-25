export interface ConfigDifference {
  path: string;
  before: unknown;
  after: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function configurationDiff(before: unknown, after: unknown, path = ''): ConfigDifference[] {
  if (Object.is(before, after)) return [];
  if (isRecord(before) && isRecord(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .flatMap((key) => configurationDiff(before[key], after[key], path ? `${path}.${key}` : key));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
  }
  return [{ path: path || 'configuration', before, after }];
}
