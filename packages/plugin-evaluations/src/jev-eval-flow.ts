import {
  AgentFlow as AgentFlowSchema,
  compileFlow,
  flowDecisionRequest as compiledDecisionRequest,
  flowIntents as compiledIntents,
  inspectFlow,
  matchFlowPhrase as compiledPhrase,
  routeFlowIntent as compiledRoute,
  type AgentFlow,
  type CompiledFlow,
  type DecisionRequest,
} from '@winsendotai/ovo-contracts';

/**
 * The AGT-1 flow contract as the importer, the Jev eval and the golden conversations read it: the
 * contract's own types and helpers, taking the authored flow instead of a compiled one so a corpus
 * stays plain JSON. The eval therefore scores exactly the request and phrase tier production uses.
 */
export {
  FLOW_INTENT_QUESTION,
  FLOW_MAX_PHRASES,
  FLOW_OTHER_DESCRIPTION,
  FLOW_OTHER_INTENT,
  routeTargets,
  type AgentFlow,
  type FlowIntent,
  type FlowListen,
  type FlowNode,
  type FlowRoute,
  type FlowSlot,
} from '@winsendotai/ovo-contracts';

const VARIABLE = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

/** Compiled once per flow object; a corpus copy that is changed is a new object. */
const compiled = new WeakMap<AgentFlow, CompiledFlow>();
function compile(flow: AgentFlow): CompiledFlow {
  let result = compiled.get(flow);
  if (!result) compiled.set(flow, (result = compileFlow(flow)));
  return result;
}

export const flowNode = (flow: AgentFlow, id: string) => flow.nodes.find((node) => node.id === id);
export const flowListen = (flow: AgentFlow, id: string) =>
  flow.listens.find((listen) => listen.id === id);
/** The listen set's own intents first, then the globals. */
export const flowIntents = (flow: AgentFlow, listenId: string) =>
  flowListen(flow, listenId) ? compiledIntents(compile(flow), listenId) : [...flow.globalIntents];

export function templateVariables(line: string): string[] {
  return [...line.matchAll(VARIABLE)].map((match) => match[1]!);
}

export function renderFlowLine(
  flow: AgentFlow,
  lineId: string,
  variables: Record<string, unknown>,
): string {
  const line = flow.lines[lineId];
  if (line === undefined) throw new Error(`Unknown line ${lineId}`);
  return line.replace(VARIABLE, (_, name: string) => {
    const value = variables[name];
    if (value === undefined || value === null) throw new Error(`Missing variable ${name}`);
    return String(value);
  });
}

/** The instant tier: the whole reply is one of an intent's phrases. */
export function matchFlowPhrase(flow: AgentFlow, listenId: string, reply: string) {
  return compiledPhrase(compile(flow), listenId, reply);
}

/**
 * Where an intent leads given the turn's slot answers: a node, a replay, the current question again
 * (`hold`), or nothing (`other`).
 */
export function routeFlowIntent(
  flow: AgentFlow,
  listenId: string,
  key: string,
  slots: Readonly<Record<string, string | undefined>> = {},
): { kind: 'node'; node: string } | { kind: 'repeat' } | { kind: 'hold' } | undefined {
  const intent = flowIntents(flow, listenId).find((candidate) => candidate.key === key);
  if (!intent) return undefined;
  const answered = Object.entries(slots).filter((entry): entry is [string, string] =>
    Boolean(entry[1]),
  );
  return compiledRoute(intent, Object.fromEntries(answered));
}

/** One round trip: the listen set's intents, the globals and `other`, plus every slot question. */
export function flowDecisionRequest(
  flow: AgentFlow,
  listenId: string,
  state: Record<string, unknown>,
): DecisionRequest {
  return compiledDecisionRequest(compile(flow), listenId, state);
}

export class FlowDocumentError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid flow:\n  ${issues.join('\n  ')}`);
    this.name = 'FlowDocumentError';
  }
}

/**
 * What a release refuses: the contract's schema and every error `inspectFlow` reports, plus, given
 * the declared variables, any line that reads an undeclared one.
 */
export function checkFlow(flow: AgentFlow, declaredVariables?: readonly string[]): AgentFlow {
  const parsed = AgentFlowSchema.safeParse(flow);
  const issues = parsed.success
    ? inspectFlow(flow)
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `${issue.path}: ${issue.message}`)
    : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  if (declaredVariables)
    for (const [id, text] of Object.entries(flow.lines))
      for (const name of templateVariables(text))
        if (!declaredVariables.includes(name))
          issues.push(`line ${id}: undeclared variable ${name}`);
  if (issues.length) throw new FlowDocumentError(issues);
  return flow;
}
