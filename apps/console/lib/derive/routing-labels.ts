import type {
  FallbackStep,
  RoutingEngine,
  RoutingNode,
  RoutingTarget,
  RulesMatcher,
} from '@winsendotai/ovo-contracts';

export const ENGINE_LABEL: Record<RoutingEngine['kind'], string> = {
  rules: 'Rules',
  decision: 'Decision engine',
  llm: 'Language model',
  external: 'External service',
};
export const TARGET_LABEL: Record<RoutingTarget['kind'], string> = {
  pool: 'Agent pool',
  agent: 'One agent',
  human: 'A person',
  callback: 'Call back later',
  end: 'End the call',
};
export const FALLBACK_LABEL: Record<FallbackStep['kind'], string> = {
  reask: 'Ask again',
  default: 'Default agent',
  human: 'A person',
  callback: 'Call back later',
  end: 'End the call',
};
export const MATCHER_LABEL: Record<RulesMatcher['kind'], string> = {
  dtmf: 'Keypad digits',
  'caller-id': 'Caller number starts with',
  time: 'Time of day',
  variable: 'Call variable',
  keywords: 'Keywords',
  phrases: 'Exact phrases',
  script: 'Writing system',
};

export const TERMINAL_FALLBACKS: readonly FallbackStep['kind'][] = ['default', 'callback', 'end'];

/** True when a fallback chain ends in a step that always gives the call somewhere to go. */
export function chainIsTerminal(steps: readonly FallbackStep[]): boolean {
  const last = steps.at(-1);
  return last !== undefined && TERMINAL_FALLBACKS.includes(last.kind);
}

export function matcherSummary(matcher: RulesMatcher): string {
  switch (matcher.kind) {
    case 'dtmf':
      return `keypad ${matcher.digits}`;
    case 'caller-id':
      return `caller ${matcher.prefixes.slice(0, 2).join(', ')}${matcher.prefixes.length > 2 ? '...' : ''}`;
    case 'time':
      return matcher.inside ? 'inside hours' : 'outside hours';
    case 'variable':
      return `${matcher.name} = ${matcher.equals.join(' / ')}`;
    case 'keywords':
      return `words ${matcher.words.slice(0, 3).join(', ')}`;
    case 'phrases':
      return `says "${matcher.phrases[0]}"`;
    case 'script':
      return `script of ${matcher.languages.join(', ')}`;
  }
}

export function engineSummary(engine: RoutingEngine): string {
  switch (engine.kind) {
    case 'rules':
      return `${engine.rules.length} rule${engine.rules.length === 1 ? '' : 's'}`;
    case 'external':
      return `threshold ${engine.threshold}`;
    default:
      return `threshold ${engine.threshold}`;
  }
}

/** The target a branch shows in the tree: "Pool Sales", "Agent a1b2", "Person: desk", "Ends call". */
export function targetSummary(
  target: RoutingTarget,
  names: { pools?: ReadonlyMap<string, string>; agents?: ReadonlyMap<string, string> } = {},
): string {
  switch (target.kind) {
    case 'pool':
      return `Pool ${names.pools?.get(target.poolId) ?? (target.poolId.slice(0, 8) || 'not chosen')}`;
    case 'agent':
      return `Agent ${names.agents?.get(target.agent.agentId) ?? (target.agent.agentId.slice(0, 12) || 'not chosen')}`;
    case 'human':
      return `Person: ${target.queueId || 'queue not chosen'}`;
    case 'callback':
      return `Call back in ${target.inMinutes} min`;
    case 'end':
      return target.disposition ? `Ends call (${target.disposition})` : 'Ends the call';
  }
}

export function stepSummary(step: FallbackStep): string {
  switch (step.kind) {
    case 'reask':
      return `Ask again (${step.times}x)`;
    case 'human':
      return `Person: ${step.queueId || 'queue not chosen'}`;
    case 'callback':
      return `Call back in ${step.inMinutes} min`;
    default:
      return FALLBACK_LABEL[step.kind];
  }
}

/** The ids of nodes reachable from a branch of this node (its direct children). */
export const childIds = (node: RoutingNode) =>
  node.branches.flatMap((b) => (b.next ? [b.next] : []));

/** Node ids in reading order from the root (depth first); unreachable nodes follow, flagged. */
export function outlineOrder(
  nodes: readonly RoutingNode[],
  root: string,
): { node: RoutingNode; depth: number; reachable: boolean }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const rows: { node: RoutingNode; depth: number; reachable: boolean }[] = [];
  const visit = (id: string, depth: number) => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    rows.push({ node, depth, reachable: true });
    for (const child of childIds(node)) visit(child, depth + 1);
  };
  visit(root, 0);
  for (const node of nodes) if (!seen.has(node.id)) rows.push({ node, depth: 0, reachable: false });
  return rows;
}
