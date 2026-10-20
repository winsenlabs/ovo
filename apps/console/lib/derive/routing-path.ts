import type { RoutingSimulationResult } from '../types/routing-simulate';

export interface Attempt {
  turn: number;
  engine: string;
  outcome: string;
  branch?: string;
  confidence?: number;
  ms?: number;
  reason?: string;
  mocked: boolean;
}
export type PathItem =
  | { kind: 'node'; node: string; attempts: Attempt[]; chosen?: string }
  | { kind: 'fallback'; node: string; step: string; result: string; reason?: string; turn: number };

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' ? value : undefined);

/** The simulated run as a chain: each question with the engines tried on it, fallbacks between. */
export function pathItems(result: RoutingSimulationResult): PathItem[] {
  const items: PathItem[] = [];
  for (const turn of result.turns)
    for (const step of turn.steps) {
      if (step.type === 'route.node') {
        const p = step.payload;
        const node = str(p.node) ?? '?';
        let block = items.at(-1);
        if (!block || block.kind !== 'node' || block.node !== node) {
          block = { kind: 'node', node, attempts: [] };
          items.push(block);
        }
        const engine = str(p.engine) ?? 'rules';
        block.attempts.push({
          turn: turn.index,
          engine,
          outcome: str(p.outcome) ?? 'no_match',
          branch: str(p.branch),
          confidence: num(p.confidence),
          ms: num(p.ms),
          reason: str(p.reason),
          mocked: step.mocked && engine !== 'rules' && engine !== 'context',
        });
        if (p.outcome === 'matched') block.chosen = str(p.branch);
      } else if (step.type === 'route.fallback') {
        const p = step.payload;
        items.push({ kind: 'fallback', node: str(p.node) ?? '?', step: str(p.step) ?? '?', result: str(p.result) ?? '?', reason: str(p.reason), turn: turn.index });
      }
    }
  return items;
}

export const takenFallbacks = (result: RoutingSimulationResult) =>
  pathItems(result).filter((i) => i.kind === 'fallback' && i.result === 'taken' && i.step !== 'reask').length;

/** One line saying where the run ended. */
export function targetLine(result: RoutingSimulationResult): string {
  const { outcome } = result;
  switch (outcome.status) {
    case 'agent':
    case 'queue':
      return outcome.agent
        ? `${outcome.status === 'queue' ? 'Queued for' : 'Agent'} ${outcome.agent.agentId}${outcome.agent.memberId ? ` (member ${outcome.agent.memberId})` : ''}`
        : 'An agent';
    case 'human':
      return outcome.human ? `Person queue ${outcome.human.queueKey}${outcome.human.precheck === 'ok' ? '' : ` (${outcome.human.precheck})`}` : 'A person';
    case 'callback':
      return outcome.callback ? `Call back in ${outcome.callback.inMinutes} minutes` : 'A callback';
    case 'end':
      return outcome.endDisposition ? `The call ends (${outcome.endDisposition})` : 'The call ends';
    default:
      return 'Undecided: the caller turns ran out while routing';
  }
}
