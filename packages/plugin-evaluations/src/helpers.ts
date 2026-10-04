import type { EvaluationCaseResult, Page } from './types.ts';

export function pageLimit(limit?: number): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Object.assign(new Error('limit must be between 1 and 100'), { statusCode: 400 });
  return limit;
}
export function encodeCursor(value: string): string {
  return Buffer.from(value).toString('base64url');
}
export function decodeCursor(value?: string): string {
  if (!value) return '';
  try {
    const decoded = Buffer.from(value, 'base64url').toString();
    if (!decoded || Buffer.from(decoded).toString('base64url') !== value)
      throw new Error('invalid');
    return decoded;
  } catch {
    throw Object.assign(new Error('Invalid cursor'), { statusCode: 400, code: 'invalid_cursor' });
  }
}
export function compareResults(
  baselineRunId: string,
  candidateRunId: string,
  baseline: EvaluationCaseResult[],
  candidate: EvaluationCaseResult[],
) {
  const before = new Map(baseline.map((item) => [item.caseId, item.passed]));
  const after = new Map(candidate.map((item) => [item.caseId, item.passed]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  return {
    baselineRunId,
    candidateRunId,
    baseline: counts(baseline),
    candidate: counts(candidate),
    regressions: ids.filter((id) => before.get(id) === true && after.get(id) !== true),
    fixes: ids.filter((id) => before.get(id) === false && after.get(id) === true),
    unchangedFailures: ids.filter((id) => before.get(id) === false && after.get(id) === false),
  };
}
function counts(items: EvaluationCaseResult[]) {
  const passed = items.filter((item) => item.passed).length;
  return { passed, failed: items.length - passed, total: items.length };
}
export function page<T>(items: T[], size: number, cursorOf: (item: T) => string): Page<T> {
  const hasMore = items.length > size,
    selected = items.slice(0, size);
  return {
    items: selected,
    nextCursor: hasMore ? encodeCursor(cursorOf(selected.at(-1)!)) : undefined,
  };
}
