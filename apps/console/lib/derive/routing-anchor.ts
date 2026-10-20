import type { RoutingIssue, RoutingPointDraft } from '@winsendotai/ovo-contracts';

export type IssueSection =
  | 'point'
  | 'languages'
  | 'lines'
  | 'node'
  | 'branch'
  | 'engine'
  | 'fallback'
  | 'transfer'
  | 'hold'
  | 'queues'
  | 'agents'
  | 'limits';

/** Where an issue shows in the designer: a tab (`section`), a node row, a field. */
export interface IssueAnchor {
  section: IssueSection;
  nodeId?: string;
  nodeIndex?: number;
  branchKey?: string;
  engineIndex?: number;
  stepIndex?: number;
  targetKey?: string;
  queueKey?: string;
  /** The last path segment, the field the message is about (`ask`, `next`, `endpoint`...). */
  field?: string;
}

/** An issue of any source: the server's, `routingDraftIssues`, or a schema check in the browser. */
export interface DraftIssue extends Omit<RoutingIssue, 'code'> {
  code: string;
  source?: 'client' | 'server';
}

const num = (value: unknown) => (typeof value === 'number' ? value : undefined);
const lastField = (path: readonly (string | number)[]) => {
  const last = path.at(-1);
  return typeof last === 'string' ? last : undefined;
};

/** Which part of the designer an issue belongs to, from its path alone (plus the draft for keys). */
export function routingIssueAnchor(
  draft: RoutingPointDraft,
  issue: Pick<DraftIssue, 'path'>,
): IssueAnchor {
  const { path } = issue;
  const field = lastField(path);
  const [head, a, b, c] = path;
  if (head === 'nodes' && typeof a === 'number') {
    const node = draft.nodes?.[a];
    const base = { nodeId: node?.id, nodeIndex: a, field };
    if (b === 'branches') {
      const branch = typeof c === 'number' ? node?.branches[c] : undefined;
      return { section: 'branch', ...base, branchKey: branch?.key };
    }
    if (b === 'engines') return { section: 'engine', ...base, engineIndex: num(c) };
    if (b === 'fallback') return { section: 'fallback', ...base, stepIndex: num(c) };
    return { section: 'node', ...base };
  }
  if (head === 'transfer') {
    const target = b === 'targets' && typeof c === 'number' ? draft.transfer?.targets[c] : undefined;
    const holdPath = a === 'hold' || path.includes('hold') || path.includes('onTimeout');
    return { section: holdPath ? 'hold' : 'transfer', targetKey: target?.key, field };
  }
  if (head === 'humanQueues' || head === 'queues') {
    const binding = typeof a === 'number' ? draft.humanQueues?.[a] : undefined;
    return { section: 'queues', queueKey: binding?.key, field };
  }
  if (head === 'language') return { section: 'languages', field };
  if (head === 'greeting' || head === 'connecting' || head === 'idle')
    return { section: 'lines', field };
  if (head === 'router' || head === 'defaultTarget') return { section: 'agents', field };
  if (head === 'limits') return { section: 'limits', field };
  return { section: 'point', field };
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
    bySection: Object.fromEntries(SECTIONS.map((s) => [s, []])) as unknown as IssueIndex['bySection'],
  };
  for (const issue of issues) {
    const anchored = { issue, anchor: routingIssueAnchor(draft, issue) };
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
      Object.entries(where).every(([key, value]) => found.anchor[key as keyof IssueAnchor] === value),
  );
}
