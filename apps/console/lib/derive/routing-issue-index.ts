import {
  routingIssueAnchor,
  type IssueAnchor as ContractAnchor,
  type RoutingIssue,
  type RoutingPointDraft,
} from '@winsendotai/ovo-contracts';

export type IssueSection = ContractAnchor['section'];

/** Where an issue shows in the designer: a tab (`section`), a node row, a field. */
export interface IssueAnchor extends ContractAnchor {
  /** The last path segment, the field the message is about (`ask`, `next`, `endpoint`...). */
  field?: string;
}

/** An issue of any source: the server's, `routingDraftIssues`, or a schema check in the browser. */
export interface DraftIssue extends Omit<RoutingIssue, 'code'> {
  code: string;
  source?: 'client' | 'server';
}

/** The contract's anchor (shared with the publish preview) plus the field the message names. */
export function anchorIssue(
  draft: RoutingPointDraft,
  issue: Pick<DraftIssue, 'path'>,
): IssueAnchor {
  const last = issue.path.at(-1);
  return {
    ...routingIssueAnchor(draft, issue),
    ...(typeof last === 'string' ? { field: last } : {}),
  };
}

export interface AnchoredIssue {
  issue: DraftIssue;
  anchor: IssueAnchor;
}

export interface IssueIndex {
  all: AnchoredIssue[];
  errors: number;
  warnings: number;
  byNode: Map<string, AnchoredIssue[]>;
  bySection: Record<IssueSection, AnchoredIssue[]>;
}

const SECTIONS: IssueSection[] = [
  'point',
  'languages',
  'lines',
  'node',
  'branch',
  'engine',
  'fallback',
  'transfer',
  'hold',
  'queues',
  'agents',
  'limits',
];

/** Place every issue once, so rows and tab titles can read their own without re-walking paths. */
export function indexIssues(draft: RoutingPointDraft, issues: readonly DraftIssue[]): IssueIndex {
  const index: IssueIndex = {
    all: [],
    errors: 0,
    warnings: 0,
    byNode: new Map(),
    bySection: Object.fromEntries(
      SECTIONS.map((s) => [s, []]),
    ) as unknown as IssueIndex['bySection'],
  };
  for (const issue of issues) {
    const anchored = { issue, anchor: anchorIssue(draft, issue) };
    index.all.push(anchored);
    if (issue.severity === 'error') index.errors += 1;
    else index.warnings += 1;
    index.bySection[anchored.anchor.section].push(anchored);
    const id = anchored.anchor.nodeId;
    if (id) index.byNode.set(id, [...(index.byNode.get(id) ?? []), anchored]);
  }
  return index;
}

/** The issues of a node narrowed to a section (and optionally a branch, engine or step). */
export function issuesAt(
  index: IssueIndex,
  nodeId: string,
  section: IssueSection,
  where: Partial<Pick<IssueAnchor, 'branchKey' | 'engineIndex' | 'stepIndex' | 'field'>> = {},
): AnchoredIssue[] {
  return (index.byNode.get(nodeId) ?? []).filter(
    (found) =>
      found.anchor.section === section &&
      Object.entries(where).every(
        ([key, value]) => found.anchor[key as keyof IssueAnchor] === value,
      ),
  );
}
