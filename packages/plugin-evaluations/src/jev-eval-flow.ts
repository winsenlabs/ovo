import {
  normalizeForMatch,
  type DecisionQuestion,
  type DecisionRequest,
} from '@winsendotai/ovo-contracts';

/**
 * STAND-IN for the AGT-1 flow contract, which the flow lane writes in parallel as
 * `contracts/src/agent-flow.ts` (+ `agent-flow-compile.ts`, `agent-flow-apply.ts`). These types
 * mirror that lane's draft of 2026-10-06 field for field, so the importer, the Jev eval and the
 * golden conversations already read and write its JSON. At integration this module shrinks to
 * re-exports: `AgentFlow` and friends from contracts, `inspectFlow`/`compileFlow` for the checks
 * below, and `matchFlowPhrase`/`flowDecisionRequest`/`routeFlowIntent` for the helpers.
 */

export interface FlowSlot {
  id: string;
  question: string;
  options: { key: string; description: string }[];
}
export type FlowRoute = string | { slot: string; cases: Record<string, string>; otherwise: string };
export interface FlowIntent {
  key: string;
  description: string;
  /** Whole replies matched after `normalizeForMatch`; never a pattern. */
  phrases: string[];
  /** Exactly one of `next` and `repeat`. */
  next?: FlowRoute;
  repeat?: boolean;
}
export interface FlowListen {
  id: string;
  question: string;
  intents: FlowIntent[];
  slots: FlowSlot[];
}
export interface FlowNode {
  id: string;
  say: string[];
  listen?: string;
  end: boolean;
  disposition?: string;
  verified: boolean;
}
export interface AgentFlow {
  version: 1;
  start: string;
  context?: string;
  lines: Record<string, string>;
  nodes: FlowNode[];
  listens: FlowListen[];
  globalIntents: FlowIntent[];
  threshold: number;
  fallback: 'llm' | 'clarify';
  clarify?: string;
  repeatPrefix?: string;
}

export const FLOW_OTHER_INTENT = 'other';
export const FLOW_INTENT_QUESTION = 'intent';
export const FLOW_OTHER_DESCRIPTION =
  'None of the above fits: a question, a new topic, or anything the listed options do not cover';
/**
 * The flow lane's draft caps an intent at 100 phrases; the POC's yes-rule alone expands to 324, so
 * the integrator is asked to raise it (cross-lane request). The eval and importer hold to this.
 */
export const FLOW_MAX_PHRASES = 500;
const KEY = /^[a-z][a-z0-9_-]{0,79}$/;
const VARIABLE = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

export const flowNode = (flow: AgentFlow, id: string) => flow.nodes.find((node) => node.id === id);
export const flowListen = (flow: AgentFlow, id: string) =>
  flow.listens.find((listen) => listen.id === id);
/** The listen set's own intents first, then the globals. */
export const flowIntents = (flow: AgentFlow, listenId: string) => [
  ...(flowListen(flow, listenId)?.intents ?? []),
  ...flow.globalIntents,
];

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
  const normalized = normalizeForMatch(reply);
  if (!normalized) return undefined;
  return flowIntents(flow, listenId).find((intent) =>
    intent.phrases.some((phrase) => normalizeForMatch(phrase) === normalized),
  )?.key;
}

/** Where an intent leads given the turn's slot answers: a node, a replay, or nothing (`other`). */
export function routeFlowIntent(
  flow: AgentFlow,
  listenId: string,
  key: string,
  slots: Readonly<Record<string, string | undefined>> = {},
): { kind: 'node'; node: string } | { kind: 'repeat' } | undefined {
  const intent = flowIntents(flow, listenId).find((candidate) => candidate.key === key);
  if (!intent) return undefined;
  const route = intent.next;
  if (route === undefined) return { kind: 'repeat' };
  if (typeof route === 'string') return { kind: 'node', node: route };
  const value = slots[route.slot];
  return {
    kind: 'node',
    node: (value === undefined ? undefined : route.cases[value]) ?? route.otherwise,
  };
}

/** One round trip: the listen set's intents, the globals and `other`, plus every slot question. */
export function flowDecisionRequest(
  flow: AgentFlow,
  listenId: string,
  state: Record<string, unknown>,
): DecisionRequest {
  const listen = flowListen(flow, listenId);
  if (!listen) throw new Error(`Flow has no listen set ${listenId}`);
  const criteria: Record<string, string> = {};
  for (const intent of flowIntents(flow, listenId)) criteria[intent.key] = intent.description;
  criteria[FLOW_OTHER_INTENT] = FLOW_OTHER_DESCRIPTION;
  const questions: Record<string, DecisionQuestion> = {
    [FLOW_INTENT_QUESTION]: {
      type: 'choice',
      instructions: flow.context ? `${flow.context}\n\n${listen.question}` : listen.question,
      criteria,
    },
  };
  for (const slot of listen.slots)
    questions[slot.id] = {
      type: 'choice',
      instructions: slot.question,
      criteria: Object.fromEntries(slot.options.map((option) => [option.key, option.description])),
    };
  return { state, questions };
}

export class FlowDocumentError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid flow:\n  ${issues.join('\n  ')}`);
    this.name = 'FlowDocumentError';
  }
}

/**
 * The error-level checks of the flow lane's `inspectFlow`: unknown or duplicate ids, unknown lines,
 * listen/end consistency, routes to missing nodes or slot options, intents duplicated across a
 * listen set and the globals, one phrase meaning two intents, and unreachable nodes.
 */
export function checkFlow(flow: AgentFlow, declaredVariables?: readonly string[]): AgentFlow {
  const issues: string[] = [];
  const check = (ok: unknown, issue: string) => void (ok || issues.push(issue));
  const unique = (ids: string[], what: string) =>
    ids.forEach((id, index) => {
      check(KEY.test(id), `${what} ${id} is not a key`);
      check(ids.indexOf(id) === index, `${what} ${id} is used twice`);
    });
  unique(
    flow.nodes.map((node) => node.id),
    'node',
  );
  unique(
    flow.listens.map((listen) => listen.id),
    'listen',
  );
  const nodes = new Set(flow.nodes.map((node) => node.id));
  const line = (id: string | undefined, where: string) =>
    check(id === undefined || id in flow.lines, `${where}: line ${id} does not exist`);
  check(nodes.has(flow.start), `start node ${flow.start} does not exist`);
  line(flow.clarify, 'clarify');
  line(flow.repeatPrefix, 'repeatPrefix');
  for (const node of flow.nodes) {
    node.say.forEach((id) => line(id, `node ${node.id}`));
    check(node.end !== (node.listen !== undefined), `node ${node.id}: needs one of listen and end`);
    if (node.listen) check(flowListen(flow, node.listen), `node ${node.id}: unknown listen`);
  }
  const intents = (list: FlowIntent[], where: string, listen?: FlowListen) => {
    unique(
      list.map((intent) => intent.key),
      `${where} intent`,
    );
    const owners = new Map<string, string>();
    for (const intent of list) {
      const at = `${where} intent ${intent.key}`;
      check(intent.key !== FLOW_OTHER_INTENT, `${at}: other is automatic and reserved`);
      check((intent.next === undefined) !== (intent.repeat !== true), `${at}: next xor repeat`);
      check(intent.phrases.length <= FLOW_MAX_PHRASES, `${at}: over ${FLOW_MAX_PHRASES} phrases`);
      for (const phrase of intent.phrases) {
        const owner = owners.get(normalizeForMatch(phrase));
        check(!owner || owner === intent.key, `${at}: phrase "${phrase}" also means ${owner}`);
        owners.set(normalizeForMatch(phrase), intent.key);
      }
      const route = intent.next;
      if (route !== undefined && typeof route !== 'string') {
        const slot = listen?.slots.find((candidate) => candidate.id === route.slot);
        check(slot, `${at}: slot ${route.slot} is not asked here`);
        for (const option of Object.keys(route.cases))
          check(
            slot?.options.some((o) => o.key === option),
            `${at}: no slot option ${option}`,
          );
      }
      for (const target of routeTargets(route))
        check(nodes.has(target), `${at}: node ${target} does not exist`);
    }
  };
  intents(flow.globalIntents, 'global');
  for (const listen of flow.listens) {
    intents([...listen.intents, ...flow.globalIntents], `listen ${listen.id}`, listen);
    check(!listen.slots.some((slot) => slot.id === FLOW_INTENT_QUESTION), `${listen.id}: slot id`);
  }
  if (declaredVariables)
    for (const [id, text] of Object.entries(flow.lines))
      for (const name of templateVariables(text))
        check(declaredVariables.includes(name), `line ${id}: undeclared variable ${name}`);
  if (!issues.length) {
    const reached = reachable(flow);
    for (const node of flow.nodes) check(reached.has(node.id), `node ${node.id}: unreachable`);
  }
  if (issues.length) throw new FlowDocumentError(issues);
  return flow;
}

export function routeTargets(route: FlowRoute | undefined): string[] {
  if (route === undefined) return [];
  if (typeof route === 'string') return [route];
  return [...new Set([...Object.values(route.cases), route.otherwise])];
}

/** From the start along every intent; the globals become reachable once a node listens. */
function reachable(flow: AgentFlow): Set<string> {
  const reached = new Set<string>();
  const queue = [flow.start];
  let globals = false;
  while (queue.length) {
    const node = flowNode(flow, queue.shift()!);
    if (!node || reached.has(node.id)) continue;
    reached.add(node.id);
    if (!node.listen) continue;
    for (const intent of flowListen(flow, node.listen)!.intents)
      queue.push(...routeTargets(intent.next));
    if (!globals) for (const intent of flow.globalIntents) queue.push(...routeTargets(intent.next));
    globals = true;
  }
  return reached;
}
