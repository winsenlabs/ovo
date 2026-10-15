import {
  AgentConfig,
  readSessionEvent,
  type AgentTransferResult,
  type DecisionPort,
  type EventSink,
  type InferenceReply,
  type TransferHandover,
  type TransferTargetOffer,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior, type TransferPort } from '../src/index.ts';
import { collect, execution, llm, NOW, receipt } from './agent-call-control-fixture.ts';

export const ANNOUNCE = "I'm transferring your call now. Please stay on the line.";
export const billing: TransferTargetOffer = {
  key: 'billing',
  description: 'Payments, refunds, double charges',
  label: 'our billing team',
  confirm: 'never',
};
export const senior: TransferTargetOffer = {
  key: 'senior_desk',
  description: 'The caller asks for a senior colleague',
  confirm: 'ask',
};

export type PortRequest = Parameters<TransferPort['request']>[0];

/**
 * A fake `ovo.agent-transfer` port: it grants `targets`, refuses an `ask` target that is not
 * confirmed (`not_confirmed`, as the host does), and otherwise answers `result` or accepts.
 */
export function transferPort(
  over: {
    targets?: TransferTargetOffer[];
    inbound?: TransferHandover;
    summary?: boolean;
    result?: (input: PortRequest) => AgentTransferResult | Promise<AgentTransferResult>;
  } = {},
) {
  const requests: PortRequest[] = [];
  const commits: string[] = [];
  const cancels: string[] = [];
  const targets = over.targets ?? [billing, senior];
  const port: TransferPort = {
    ...(over.inbound ? { inbound: over.inbound } : {}),
    ...(over.summary !== undefined ? { summary: over.summary } : {}),
    targets: () => targets,
    async request(input) {
      requests.push(input);
      const ask = targets.find((target) => target.key === input.key)?.confirm === 'ask';
      if (ask && !input.confirmed) return { ok: false, reason: 'not_confirmed' };
      if (over.result) return over.result(input);
      return { ok: true, transferId: `t${requests.length}`, announcement: ANNOUNCE, queued: false };
    },
    commit: (id) => void commits.push(id),
    async cancel(id) {
      cancels.push(id);
    },
  };
  return { port, requests, commits, cancels };
}

export function eventSink() {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const sink: EventSink = {
    append: async (type, payload) => {
      readSessionEvent(type, payload);
      events.push({ type, payload });
    },
  };
  return { sink, events };
}

export const transferCall = (target: string, extra: Record<string, unknown> = {}) =>
  ({
    kind: 'tool',
    toolId: 'transfer_to_agent',
    input: { target, summary: 'Double charged on the October bill.', ...extra },
  }) as InferenceReply;

/** An agent offered transfers (`handoff.agents`), over a fake port and a scripted LLM. */
export function transferAgent(
  options: {
    over?: Record<string, unknown>;
    agents?: Record<string, unknown>;
    replies?: InferenceReply[];
    port?: ReturnType<typeof transferPort> | null;
    model?: ReturnType<typeof llm> | null;
    decision?: DecisionPort;
  } = {},
) {
  const port = options.port === null ? undefined : (options.port ?? transferPort());
  const model = options.model === null ? undefined : (options.model ?? llm(options.replies));
  const { sink, events } = eventSink();
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Sales',
      mode: 'agent',
      handoff: { agents: { llmTool: true, ...options.agents } },
      ...options.over,
    }),
    model?.port,
    execution,
    {
      workspaceId: 'w-1',
      sessionId: 's-1',
      now: () => NOW,
      events: sink,
      ...(port ? { transfer: port.port } : {}),
      ...(options.decision ? { decision: options.decision } : {}),
    },
  );
  let epoch = 0;
  /** One engine turn: its lines, each played to the end unless `played` is false. */
  const turn = async (
    input: string,
    vars: Record<string, unknown> = {},
    played: 'completed' | 'interrupted' | false = 'completed',
  ) => {
    behavior.beginTurn(++epoch);
    const said = await collect(behavior.respondStream(input, vars));
    if (played) for (const line of said) behavior.onPlayback(receipt(line, epoch, played));
    return said;
  };
  return { behavior, port, model, events, turn, epoch: () => epoch };
}
