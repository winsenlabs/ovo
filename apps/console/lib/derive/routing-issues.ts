import { RoutingPointDraft, routingDraftIssues } from '@winsendotai/ovo-contracts';
import type { DraftIssue } from './routing-anchor';

interface ZodLike {
  code?: string;
  path: PropertyKey[];
  message: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  input?: unknown;
}

/** A schema message an operator can act on (the library's own text names regexes and bounds). */
export function friendlyMessage(issue: ZodLike): string {
  switch (issue.code) {
    case 'too_small':
      return issue.origin === 'array' || issue.origin === 'string'
        ? `Needs at least ${issue.minimum} ${issue.origin === 'array' ? 'item(s)' : 'character(s)'}`
        : `Must be at least ${issue.minimum}`;
    case 'too_big':
      return issue.origin === 'array' || issue.origin === 'string'
        ? `At most ${issue.maximum} ${issue.origin === 'array' ? 'item(s)' : 'character(s)'}`
        : `Must be at most ${issue.maximum}`;
    case 'invalid_format':
      return 'Not in the allowed format';
    case 'invalid_value':
      return 'Choose one of the listed options';
    case 'invalid_type':
      return issue.input === undefined ? 'Required' : 'Not the expected kind of value';
    default:
      return issue.message;
  }
}

/** Schema problems and the structural checks `routingDraftIssues` makes, computed in the browser. */
export function clientIssues(draft: RoutingPointDraft): DraftIssue[] {
  const found: DraftIssue[] = [];
  const parsed = RoutingPointDraft.safeParse(draft);
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      found.push({
        code: 'schema',
        severity: 'error',
        path: issue.path.map((p) => (typeof p === 'number' ? p : String(p))),
        message: friendlyMessage(issue as unknown as ZodLike),
        source: 'client',
      });
  try {
    for (const issue of routingDraftIssues(draft)) found.push({ ...issue, source: 'client' });
  } catch {
    // A draft too broken for the structural walk is already reported by the schema issues above.
  }
  return found;
}

const keyOf = (issue: DraftIssue) => `${issue.code}|${issue.path.join('.')}`;

/**
 * The browser's issues first, then the server's that the browser did not already say. A server
 * resolution issue (a missing release, an unreachable queue) never has a client twin.
 */
export function mergeIssues(client: readonly DraftIssue[], server: readonly DraftIssue[]) {
  const seen = new Set(client.map(keyOf));
  return [
    ...client,
    ...server
      .filter((issue) => !seen.has(keyOf(issue)))
      .map((i) => ({ ...i, source: 'server' as const })),
  ];
}

/** True when the draft has an issue that makes a server round trip pointless (a schema error). */
export const hasSchemaErrors = (issues: readonly DraftIssue[]) =>
  issues.some((issue) => issue.code === 'schema');
