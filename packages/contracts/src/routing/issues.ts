import { ROUTING_LIMITS, type RouteLines } from './ids.ts';
import type { RoutingIssueCode } from './issue-codes.ts';
import type { RoutingPointDraft } from './point.ts';
import { routingNodeTargets, type RoutingNode, type RoutingPath } from './tree.ts';
import { routingPoolIds } from './transfer.ts';
import { queueDraftIssues } from './queue-issues.ts';
import { transferDraftIssues, transferLines } from './transfer-issues.ts';

export type RoutingIssueSeverity = 'error' | 'warning';
export interface RoutingIssue {
  code: RoutingIssueCode;
  severity: RoutingIssueSeverity;
  path: RoutingPath;
  message: string;
}

/** Rule matchers that read the caller's reply (the others need no caller turn). */
const TURN_MATCHERS = new Set(['dtmf', 'keywords', 'phrases', 'script']);
const TERMINAL_STEPS = new Set(['default', 'callback', 'end']);

/** True when the node can only decide on a caller turn, so it must be able to ask for one. */
function needsTurn(node: RoutingNode): boolean {
  return node.engines.some((engine) => {
    if (engine.kind === 'rules')
      return engine.rules.some((rule) => rule.when.some((m) => TURN_MATCHERS.has(m.kind)));
    return engine.kind === 'external' ? engine.send.turnText : true;
  });
}

/**
 * Every `RouteLines` the router speaks, with its path: greeting, connecting, idle prompts, asks,
 * re-asks and end/callback lines. Transfer lines are `transferLines`.
 */
export function routingLines(
  draft: Pick<RoutingPointDraft, 'greeting' | 'connecting' | 'idle' | 'nodes'>,
): { path: RoutingPath; lines: RouteLines }[] {
  const found: { path: RoutingPath; lines: RouteLines }[] = [
    { path: ['greeting'], lines: draft.greeting },
  ];
  if (draft.connecting) found.push({ path: ['connecting'], lines: draft.connecting });
  draft.idle?.prompts.forEach((lines, i) => found.push({ path: ['idle', 'prompts', i], lines }));
  draft.nodes.forEach((node, n) => {
    if (node.ask) found.push({ path: ['nodes', n, 'ask'], lines: node.ask });
    node.fallback.forEach((step, s) => {
      if (step.kind === 'reask' && step.line)
        found.push({ path: ['nodes', n, 'fallback', s, 'line'], lines: step.line });
    });
  });
  for (const { path, target } of routingNodeTargets(draft.nodes))
    if (target.kind === 'end' || target.kind === 'callback')
      found.push({ path: [...path, 'line'], lines: target.line });
  return found;
}

/** Root, ids, `next` references, cycles, reachability and depth. */
function graphIssues(draft: RoutingPointDraft, add: Add): void {
  const index = new Map<string, number>();
  draft.nodes.forEach((node, n) => {
    if (index.has(node.id))
      add('routing_node_duplicate', ['nodes', n, 'id'], `Node ${node.id} is defined twice`);
    else index.set(node.id, n);
  });
  draft.nodes.forEach((node, n) =>
    node.branches.forEach((branch, b) => {
      if (branch.next !== undefined && !index.has(branch.next))
        add('routing_node_unknown', ['nodes', n, 'branches', b, 'next'], `No node ${branch.next}`);
    }),
  );
  const root = index.get(draft.root);
  if (root === undefined) {
    add('routing_root_missing', ['root'], `The root ${draft.root} names no node`);
    return;
  }
  const state = new Map<number, 'open' | 'done'>();
  const order: number[] = [];
  const visit = (n: number): void => {
    state.set(n, 'open');
    draft.nodes[n]!.branches.forEach((branch, b) => {
      const next = branch.next === undefined ? undefined : index.get(branch.next);
      if (next === undefined) return;
      if (state.get(next) === 'open')
        add('routing_node_cycle', ['nodes', n, 'branches', b, 'next'], `${branch.next} loops back`);
      else if (!state.has(next)) visit(next);
    });
    state.set(n, 'done');
    order.push(n);
  };
  visit(root);
  // Reverse post-order is a topological order of the reachable tree once loop edges are ignored,
  // so the longest path to every node is settled before the node is read.
  const topo = order.reverse();
  const position = new Map(topo.map((n, i) => [n, i]));
  const depth = new Map<number, number>([[root, 1]]);
  for (const n of topo) {
    const here = depth.get(n) ?? 1;
    if (here > ROUTING_LIMITS.depth) {
      add(
        'routing_depth_exceeded',
        ['nodes', n],
        `Node ${draft.nodes[n]!.id} is ${here} levels deep`,
      );
      break;
    }
    for (const branch of draft.nodes[n]!.branches) {
      const next = branch.next === undefined ? undefined : index.get(branch.next);
      if (next !== undefined && position.get(next)! > position.get(n)!)
        depth.set(next, Math.max(depth.get(next) ?? 0, here + 1));
    }
  }
  draft.nodes.forEach((node, n) => {
    if (index.get(node.id) === n && !state.has(n))
      add(
        'routing_node_unreachable',
        ['nodes', n],
        `Node ${node.id} cannot be reached from the root`,
        'warning',
      );
  });
}

export type Add = (
  code: RoutingIssueCode,
  path: RoutingPath,
  message: string,
  severity?: RoutingIssueSeverity,
) => void;

/** Pure structural validation of a draft, shared by the API (publish, validate) and the router. */
export function routingDraftIssues(draft: RoutingPointDraft): RoutingIssue[] {
  const issues: RoutingIssue[] = [];
  const add: Add = (code, path, message, severity = 'error') =>
    issues.push({ code, severity, path, message });
  graphIssues(draft, add);
  const allowed = new Set(draft.language.allowed);
  if (!allowed.has(draft.language.default))
    add(
      'routing_language_unallowed',
      ['language', 'allowed'],
      'The allowed languages include the default',
    );
  for (const { path, lines } of [...routingLines(draft), ...transferLines(draft.transfer)]) {
    if (!Object.hasOwn(lines, draft.language.default))
      add('routing_line_default_missing', path, `No ${draft.language.default} line`);
    for (const language of Object.keys(lines))
      if (!allowed.has(language))
        add(
          'routing_language_unallowed',
          [...path, language],
          `${language} is not an allowed language`,
        );
  }
  draft.nodes.forEach((node, n) => {
    const keys = new Set<string>();
    node.branches.forEach((branch, b) => {
      if (keys.has(branch.key))
        add(
          'routing_branch_duplicate',
          ['nodes', n, 'branches', b, 'key'],
          `Branch ${branch.key} is defined twice`,
        );
      keys.add(branch.key);
      if (node.sets === 'language' && !allowed.has(branch.key))
        add(
          'routing_language_unallowed',
          ['nodes', n, 'branches', b, 'key'],
          `${branch.key} is not an allowed language`,
        );
    });
    node.engines.forEach((engine, e) => {
      if (engine.kind !== 'rules') return;
      engine.rules.forEach((rule, r) => {
        if (!keys.has(rule.branch))
          add(
            'routing_rule_branch_unknown',
            ['nodes', n, 'engines', e, 'rules', r, 'branch'],
            `No branch ${rule.branch}`,
          );
      });
    });
    const last = node.fallback.at(-1);
    if (!last || !TERMINAL_STEPS.has(last.kind))
      add(
        'routing_fallback_not_terminal',
        ['nodes', n, 'fallback'],
        'The fallback chain ends in default, callback or end',
      );
    const reaskLine = node.fallback.some((step) => step.kind === 'reask' && step.line);
    if (needsTurn(node) && !node.ask && !reaskLine)
      add(
        'routing_node_ask_missing',
        ['nodes', n, 'ask'],
        `Node ${node.id} waits for the caller but has nothing to ask`,
      );
    if (
      node.engines.length > ROUTING_LIMITS.enginesPerNode ||
      node.branches.length > ROUTING_LIMITS.branchesPerNode ||
      node.fallback.length > ROUTING_LIMITS.fallbackSteps
    )
      add(
        'routing_limits_exceeded',
        ['nodes', n],
        `Node ${node.id} is over the engine, branch or fallback limit`,
      );
  });
  for (const { path, target } of routingNodeTargets(draft.nodes)) {
    if (target.kind === 'human' && !draft.humanQueues?.length)
      add(
        'routing_human_unavailable',
        path,
        'Human queues arrive in a later release; this step is skipped',
        'warning',
      );
  }
  if (draft.nodes.length > ROUTING_LIMITS.nodes)
    add('routing_limits_exceeded', ['nodes'], `At most ${ROUTING_LIMITS.nodes} nodes`);
  if (routingPoolIds(draft).length > ROUTING_LIMITS.poolsPerRelease)
    add('routing_limits_exceeded', ['nodes'], `At most ${ROUTING_LIMITS.poolsPerRelease} pools`);
  transferDraftIssues(draft, add);
  queueDraftIssues(draft, add);
  return issues;
}
