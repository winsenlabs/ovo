import type {
  AgentFlow,
  FlowEndpointing,
  FlowListen,
  FlowPosition,
  FlowRoute,
} from './agent-flow.ts';

/** Read-only questions about an authored flow, shared by the compiler, the runtime and the console. */

/** Every node a route can lead to. */
export function routeTargets(route: FlowRoute | undefined): string[] {
  if (route === undefined) return [];
  if (typeof route === 'string') return [route];
  return [...new Set([...Object.values(route.cases), route.otherwise])];
}

/** Every authored line the flow can speak, with its path for error messages. */
export function flowLineTemplates(
  flow: AgentFlow,
): { id: string; field: string; template: string }[] {
  return Object.entries(flow.lines).map(([id, template]) => ({
    id,
    field: `lines.${id}`,
    template,
  }));
}

/**
 * True when some path can reach the LLM: a fallback to it, or a node with no lines of its own. A
 * flow without either runs on the decision model alone (Jev-only).
 */
export function flowReachesLlm(flow: AgentFlow): boolean {
  return flow.fallback === 'llm' || flow.nodes.some((node) => node.say.length === 0);
}

/**
 * True when an enabled flow's start node has lines: the agent then greets first with them, the
 * same way an `opening` does, so an outbound call waits for the answering-machine verdict too.
 */
export function flowSpeaksFirst(policy: { enabled: boolean; flow?: AgentFlow } | undefined) {
  const flow = policy?.enabled ? policy.flow : undefined;
  return Boolean(flow?.nodes.find((node) => node.id === flow.start)?.say.length);
}

/** The wire limit on a decision question's instructions (`decision.ts`). */
export const FLOW_INSTRUCTIONS_LIMIT = 2_000;

/** What the decision model is asked for a listen set: the flow's context, then the question. */
export function flowListenInstructions(flow: AgentFlow, listen: FlowListen): string {
  return flow.context ? `${flow.context}\n\n${listen.question}` : listen.question;
}

/**
 * The endpointing a call uses in `position`: the node's, else its listen set's, else the flow's.
 * A node's own setting holds only while the call listens with the node's listen set: after the LLM
 * resumes the flow at another one, that listen set decides. Undefined when nothing sets one, so the
 * STT keeps what it has.
 */
export function flowEndpointing(
  flow: AgentFlow,
  position: FlowPosition,
): FlowEndpointing | undefined {
  const node = flow.nodes.find((candidate) => candidate.id === position.node);
  const listen = flow.listens.find((candidate) => candidate.id === position.listen);
  const own = node?.listen === undefined || node.listen === position.listen;
  return (own ? node?.endpointing : undefined) ?? listen?.endpointing ?? flow.endpointing;
}
