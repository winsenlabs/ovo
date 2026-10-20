import type { NumberRow, ReleaseSummary } from '../types/routing';

export const isRouted = (row: NumberRow) => row.routingReleaseId !== null && row.routing !== null;
export const modeLabel = (row: NumberRow) => (isRouted(row) ? 'Routing point' : 'Direct agent');

export const numbersOfPoint = (rows: readonly NumberRow[], pointId: string) =>
  rows.filter((row) => row.routing?.pointId === pointId);
export const bindableNumbers = (rows: readonly NumberRow[], pointId: string) =>
  rows.filter((row) => row.routing?.pointId !== pointId);

/** A number pinned to a release older than the newest one. */
export function isBehind(row: NumberRow, releases: readonly ReleaseSummary[]): boolean {
  const latest = releases.reduce((max, r) => Math.max(max, r.version), 0);
  return row.routing !== null && latest > 0 && row.routing.version < latest;
}

/** What binding does to a number, in words: the consequence the operator confirms. */
export function bindConsequence(row: NumberRow, pointName: string, version: number): { text: string; needsConfirm: boolean } {
  if (!isRouted(row))
    return {
      text: `Calls to this number now go to the agent release it is bound to. After binding, they reach ${pointName} version ${version} first: the router greets the caller and chooses the agent. The number's variables are checked against the router.`,
      needsConfirm: true,
    };
  if (row.routing && row.routing.pointName !== pointName)
    return { text: `This number is bound to ${row.routing.pointName}. It will move to ${pointName} version ${version}.`, needsConfirm: true };
  const from = row.routing?.version ?? 0;
  return {
    text: version < from ? `This rolls the number back from version ${from} to version ${version}.` : `This moves the number from version ${from} to version ${version}.`,
    needsConfirm: false,
  };
}
