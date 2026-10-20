import type { RoutingIssue } from './issues.ts';
import type { RoutingPointDraft } from './point.ts';
import type { RoutingPath } from './tree.ts';

/** Where an issue shows in the designer. */
export interface IssueAnchor {
  section:
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
  nodeId?: string;
  nodeIndex?: number;
  branchKey?: string;
  engineIndex?: number;
  stepIndex?: number;
  /** A transfer target key, or (section `agents`) the pool a member path names. */
  targetKey?: string;
  queueKey?: string;
}

const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

function nodeAnchor(draft: RoutingPointDraft, path: RoutingPath): IssueAnchor {
  const nodeIndex = num(path[1]);
  const node = nodeIndex === undefined ? undefined : draft.nodes[nodeIndex];
  const base = {
    ...(node ? { nodeId: node.id } : {}),
    ...(nodeIndex === undefined ? {} : { nodeIndex }),
  };
  const part = path[2];
  const at = num(path[3]);
  if (part === 'branches')
    return {
      section: 'branch',
      ...base,
      ...(at !== undefined && node?.branches[at] ? { branchKey: node.branches[at].key } : {}),
    };
  if (part === 'engines')
    return { section: 'engine', ...base, ...(at === undefined ? {} : { engineIndex: at }) };
  if (part === 'fallback')
    return { section: 'fallback', ...base, ...(at === undefined ? {} : { stepIndex: at }) };
  return { section: 'node', ...base };
}

function transferAnchor(draft: RoutingPointDraft, path: RoutingPath): IssueAnchor {
  if (path[1] === 'hold') return { section: 'hold' };
  if (path[1] === 'limits') return { section: 'limits' };
  const t = path[1] === 'targets' ? num(path[2]) : undefined;
  const target = t === undefined ? undefined : draft.transfer?.targets[t];
  const key = target ? { targetKey: target.key } : {};
  return { section: path[3] === 'hold' ? 'hold' : 'transfer', ...key };
}

/**
 * Places an issue, by its path, on the part of the designer that concerns it: the node, branch,
 * engine or fallback step it names, a transfer target or hold, a queue binding. A path the
 * designer has no part for (or none at all) anchors to the point.
 */
export function routingIssueAnchor(
  draft: RoutingPointDraft,
  issue: Pick<RoutingIssue, 'path'>,
): IssueAnchor {
  const { path } = issue;
  switch (path[0]) {
    case 'nodes':
      return nodeAnchor(draft, path);
    case 'language':
      return { section: 'languages' };
    case 'greeting':
    case 'connecting':
    case 'idle':
      return { section: 'lines' };
    case 'router':
    case 'defaultTarget':
      return { section: 'agents' };
    case 'pools':
      return { section: 'agents', ...(typeof path[1] === 'string' ? { targetKey: path[1] } : {}) };
    case 'transfer':
      return transferAnchor(draft, path);
    case 'humanQueues': {
      const binding = typeof path[1] === 'number' ? draft.humanQueues?.[path[1]] : undefined;
      return { section: 'queues', ...(binding ? { queueKey: binding.key } : {}) };
    }
    case 'queues': {
      const binding = draft.humanQueues?.find((candidate) => candidate.queueId === path[1]);
      return { section: 'queues', ...(binding ? { queueKey: binding.key } : {}) };
    }
    case 'limits':
      return { section: 'limits' };
    default:
      return { section: 'point' };
  }
}
