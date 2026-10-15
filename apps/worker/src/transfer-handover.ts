import type { CallMemory, TranscriptLine } from './call-memory.ts';
import type { AttemptTarget } from './transfer-attempt.ts';
import type { TransferControllerDeps, TransferRun } from './transfer-types.ts';
import {
  filterDeclaredVariables,
  TRANSFER_LIMITS,
  type AgentConfig,
  type HandoffTransferMeta,
  type RoutingTransferPolicy,
  type TransferHandover,
} from '@winsendotai/ovo-contracts';

/** The point's handover policy when it has none (transfer design 17, default 5). */
export const DEFAULT_HANDOVER: RoutingTransferPolicy['handover'] = {
  summary: true,
  transcriptTurns: 6,
  capturedVariables: true,
};

/**
 * What an incoming segment inherits (transfer design 7.9), built when it starts from the call's
 * memory and the request: the last `transcriptTurns` caller turns with the agent lines between
 * them (oldest first, each line at most 500 characters, at most 6000 in all, oldest dropped
 * first), the transferring LLM's summary and reason when the policy keeps them, the captured
 * values the target's schema declares and accepts, the route and the disclosures heard.
 *
 * The free text in it (summary, reason, transcript) is caller-derived and untrusted: it only ever
 * reaches the target agent through its transfer port, never an event, a log or the database.
 */
export function buildHandover(input: {
  kind: TransferHandover['kind'];
  transfer?: number;
  from?: TransferHandover['from'];
  targetKey?: string;
  label?: string;
  meta?: HandoffTransferMeta;
  policy?: RoutingTransferPolicy['handover'];
  memory: CallMemory;
  target: Pick<AgentConfig, 'variables'>;
}): TransferHandover {
  const policy = input.policy ?? DEFAULT_HANDOVER;
  const { memory, meta } = input;
  const keepText = policy.summary && input.kind === 'transfer';
  return {
    kind: input.kind,
    ...(input.transfer !== undefined ? { transfer: input.transfer } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.targetKey ? { targetKey: input.targetKey } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(keepText && meta?.reason
      ? { reason: meta.reason.slice(0, TRANSFER_LIMITS.reasonChars) }
      : {}),
    ...(keepText && meta?.summary
      ? { summary: meta.summary.slice(0, TRANSFER_LIMITS.summaryChars) }
      : {}),
    transcript: recentTurns(memory.recent(), policy.transcriptTurns),
    ...(memory.route
      ? {
          route: {
            path: [...memory.route.path],
            ...(memory.route.language ? { language: memory.route.language } : {}),
            context: { ...memory.route.context },
          },
        }
      : {}),
    captured: policy.capturedVariables
      ? filterDeclaredVariables(input.target, memory.captured)
      : {},
    disclosed: [...memory.disclosed],
  };
}

/** The last `turns` caller turns and what the agents said around them, within the char bound. */
export function recentTurns(
  lines: readonly TranscriptLine[],
  turns: number,
): { role: 'caller' | 'agent'; text: string }[] {
  if (turns <= 0) return [];
  let callers = 0;
  let from = lines.length;
  while (from > 0) {
    if (lines[from - 1]!.role === 'caller' && callers === turns) break;
    from -= 1;
    if (lines[from]!.role === 'caller') callers += 1;
  }
  const kept = lines.slice(from).map((line) => ({ role: line.role, text: line.text }));
  let chars = kept.reduce((sum, line) => sum + line.text.length, 0);
  while (chars > TRANSFER_LIMITS.transcriptChars && kept.length) chars -= kept.shift()!.text.length;
  return kept;
}

/**
 * The call's captured values for a composed target's variables (design 7.9, 11): none when the
 * point's handover withholds them (`capturedVariables: false`), so they reach neither the target's
 * handover nor its prompt and tools. The composer keeps those the target's schema accepts.
 */
export function capturedFor(deps: Pick<TransferControllerDeps, 'policy' | 'memory'>): {
  captured?: Record<string, unknown>;
} {
  const policy = deps.policy?.handover ?? DEFAULT_HANDOVER;
  return policy.capturedVariables ? { captured: { ...deps.memory.captured } } : {};
}

/** What a run's attempt at `target` hands over, built for the target's schema when asked. */
export function runHandover(
  run: TransferRun,
  target: Pick<AttemptTarget, 'reason'>,
  deps: Pick<TransferControllerDeps, 'policy' | 'memory'>,
): (config: Pick<AgentConfig, 'variables'>) => TransferHandover {
  const kind = target.reason === 'return' ? 'return' : run.transfer ? 'transfer' : 'route';
  return (config) =>
    buildHandover({
      kind,
      ...(run.transfer !== undefined ? { transfer: run.transfer } : {}),
      from: { role: run.from.role, agentId: run.from.agentId, releaseId: run.from.releaseId },
      ...(run.target ? { targetKey: run.target.key } : {}),
      ...(run.meta ? { meta: run.meta } : {}),
      ...(deps.policy ? { policy: deps.policy.handover } : {}),
      memory: deps.memory,
      target: config,
    });
}
