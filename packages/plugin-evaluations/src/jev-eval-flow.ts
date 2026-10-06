import type { DecisionRequest } from '@winsendotai/ovo-contracts';

/**
 * The state-aware flow as JSON: what the POC conversation map imports to and what the Jev eval and
 * the golden conversations read. It follows the AGT-1 shape in the backlog (nodes with `say`,
 * `listen`, `end`, `disposition`, `actions` and `verified`; listens with a question, intents with
 * descriptions, rules and `next`, and slots; global intents; an automatic `other`).
 *
 * It is a stand-in. The flow contract (`contracts/src/agent-flow.ts`) is written in parallel by the
 * flow lane; once it lands this type is replaced by it and only `flowDecisionRequest` here needs to
 * become a call to that lane's compiler, so the eval scores exactly the request production sends.
 */

export interface FlowRules {
  /** Whole utterances, already normalized with `normalizeUtterance`. Never a user regex. */
  phrases: string[];
}

/** A plain target, or a target chosen by one slot's answer (`otherwise` for unlisted answers). */
export type FlowNext = string | { slot: string; cases: Record<string, string>; otherwise: string };

export interface FlowIntent {
  /** The only text the decision model sees for this intent. */
  description: string;
  rules?: FlowRules;
  next: FlowNext;
}

export interface FlowGlobalIntent {
  description: string;
  rules?: FlowRules;
  /** Absent only on the replay intent. */
  next?: string;
  /** Replays the agent's last lines after `recovery.repeatPrefix` instead of moving on. */
  repeat?: true;
}

export interface FlowSlot {
  question: string;
  options: Record<string, string>;
}

export interface FlowListen {
  question: string;
  intents: Record<string, FlowIntent>;
  slots?: Record<string, FlowSlot>;
}

export interface FlowNode {
  say: string[];
  listen?: string;
  end?: true;
  disposition?: string;
  actions?: string[];
  /** Entering this node verifies the caller's identity. */
  verified?: true;
}

export interface FlowDocument {
  version: 1;
  name: string;
  /** The preamble of every intent question: who calls, about what, in which languages. */
  context: string;
  start: string;
  /** Per-call variables the lines read, as `{{name}}`. */
  variables: string[];
  lines: Record<string, string>;
  nodes: Record<string, FlowNode>;
  listens: Record<string, FlowListen>;
  globalIntents: Record<string, FlowGlobalIntent>;
  other: { description: string };
  /** One prompt per silent turn, then the `end` node. */
  idle: { prompts: string[]; end: string };
  recovery: { repeatPrefix: string; didntCatch: string; fillers: string[] };
  source?: Record<string, string>;
}

export const OTHER_INTENT = 'other';
const ID = /^[a-z][a-z0-9_-]{0,79}$/;
const VARIABLE = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

export class FlowDocumentError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid flow document:\n  ${issues.join('\n  ')}`);
    this.name = 'FlowDocumentError';
  }
}

/** Lowercase, punctuation stripped, whitespace collapsed. Letters and marks of any script survive. */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function templateVariables(line: string): string[] {
  return [...line.matchAll(VARIABLE)].map((match) => match[1]!);
}

export function renderFlowLine(
  flow: FlowDocument,
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

/** The instant tier: the current listen's rules first, then the global intents' rules. */
export function matchFlowRules(
  flow: FlowDocument,
  listenId: string,
  text: string,
): string | undefined {
  const normalized = normalizeUtterance(text);
  if (!normalized) return undefined;
  const candidates = [
    ...Object.entries(flow.listens[listenId]?.intents ?? {}),
    ...Object.entries(flow.globalIntents),
  ];
  return candidates.find(([, intent]) => intent.rules?.phrases.includes(normalized))?.[0];
}

/** Where an intent leads. Undefined for `other`, for replay and for an unknown intent. */
export function resolveNext(
  flow: FlowDocument,
  listenId: string,
  intent: string,
  slots: Record<string, string | undefined> = {},
): string | undefined {
  const next = flow.listens[listenId]?.intents[intent]?.next ?? flow.globalIntents[intent]?.next;
  if (next === undefined || typeof next === 'string') return next;
  return next.cases[slots[next.slot] ?? ''] ?? next.otherwise;
}

export interface FlowDecisionState {
  agent_last_said: string;
  recent_turns: string[];
  caller_reply: string;
  today: string;
}

/**
 * One decision request per caller reply: a choice over the listen's intents, the global intents and
 * `other`, plus every slot question of that listen in the same round trip (POC `buildJevRequest`).
 */
export function flowDecisionRequest(
  flow: FlowDocument,
  listenId: string,
  state: FlowDecisionState,
): DecisionRequest {
  const listen = flow.listens[listenId];
  if (!listen) throw new Error(`Unknown listen ${listenId}`);
  const criteria: Record<string, string> = {};
  for (const [key, intent] of Object.entries(listen.intents)) criteria[key] = intent.description;
  for (const [key, intent] of Object.entries(flow.globalIntents))
    criteria[key] = intent.description;
  criteria[OTHER_INTENT] = flow.other.description;
  const questions: DecisionRequest['questions'] = {
    intent: { type: 'choice', instructions: `${flow.context}\n\n${listen.question}`, criteria },
  };
  for (const [id, slot] of Object.entries(listen.slots ?? {}))
    questions[id] = { type: 'choice', instructions: slot.question, criteria: { ...slot.options } };
  return { state: { current_state_question: listen.question, ...state }, questions };
}

/** Structural and graph checks: unknown references, duplicate intents, undeclared variables. */
export function parseFlowDocument(raw: unknown): FlowDocument {
  const flow = raw as FlowDocument;
  const issues: string[] = [];
  const check = (ok: unknown, issue: string) => {
    if (!ok) issues.push(issue);
  };
  if (!flow || typeof flow !== 'object') throw new FlowDocumentError(['not an object']);
  check(flow.version === 1, 'version must be 1');
  for (const key of ['lines', 'nodes', 'listens', 'globalIntents'] as const)
    if (!flow[key] || typeof flow[key] !== 'object')
      throw new FlowDocumentError([`${key} missing`]);
  const ids = (record: object, kind: string) => {
    for (const id of Object.keys(record)) check(ID.test(id), `${kind} id ${id} is not an id`);
  };
  ids(flow.nodes, 'node');
  ids(flow.listens, 'listen');
  ids(flow.globalIntents, 'global intent');
  const line = (id: string, where: string) =>
    check(id in flow.lines, `${where}: unknown line ${id}`);
  const node = (id: string, where: string) =>
    check(id in flow.nodes, `${where}: unknown node ${id}`);
  node(flow.start, 'start');

  const declared = new Set(flow.variables ?? []);
  for (const [id, text] of Object.entries(flow.lines))
    for (const name of templateVariables(text))
      check(declared.has(name), `line ${id}: undeclared variable ${name}`);
  for (const [id, entry] of Object.entries(flow.nodes)) {
    check(entry.say?.length, `node ${id}: says nothing`);
    for (const lineId of entry.say ?? []) line(lineId, `node ${id}`);
    check(!entry.end !== !entry.listen, `node ${id}: needs exactly one of listen and end`);
    if (entry.listen) check(entry.listen in flow.listens, `node ${id}: unknown listen`);
  }
  for (const [id, listen] of Object.entries(flow.listens)) {
    const slots = listen.slots ?? {};
    check(!('intent' in slots), `listen ${id}: a slot cannot be named intent`);
    const intents = Object.keys(listen.intents);
    check(intents.length, `listen ${id}: has no intents`);
    for (const [key, intent] of Object.entries(listen.intents)) {
      const where = `listen ${id} intent ${key}`;
      check(ID.test(key) && key !== OTHER_INTENT, `${where}: reserved or malformed key`);
      check(!(key in flow.globalIntents), `${where}: duplicates a global intent`);
      check(intent.description?.trim(), `${where}: no description`);
      if (typeof intent.next === 'string') node(intent.next, where);
      else {
        const options = slots[intent.next?.slot]?.options;
        check(options, `${where}: unknown slot ${intent.next?.slot}`);
        node(intent.next?.otherwise, where);
        for (const [option, target] of Object.entries(intent.next?.cases ?? {})) {
          check(options && option in options, `${where}: unknown slot option ${option}`);
          node(target, where);
        }
      }
    }
    check(intents.length + Object.keys(flow.globalIntents).length + 1 <= 255, `listen ${id}: >255`);
  }
  for (const [key, intent] of Object.entries(flow.globalIntents)) {
    check(key !== OTHER_INTENT, 'other is automatic and cannot be declared');
    check(!intent.next !== !intent.repeat, `global ${key}: needs exactly one of next and repeat`);
    if (intent.next) node(intent.next, `global ${key}`);
  }
  for (const id of flow.idle?.prompts ?? []) line(id, 'idle');
  node(flow.idle?.end, 'idle end');
  for (const id of [flow.recovery?.repeatPrefix, flow.recovery?.didntCatch]) line(id, 'recovery');
  for (const id of flow.recovery?.fillers ?? []) line(id, 'recovery filler');
  if (!issues.length)
    for (const id of unreachableNodes(flow)) issues.push(`node ${id}: unreachable`);
  if (issues.length) throw new FlowDocumentError(issues);
  return flow;
}

/** The nodes a listen's intents lead to, every slot case included. */
export function flowTargets(flow: FlowDocument, listenId: string): string[] {
  return Object.values(flow.listens[listenId]!.intents).flatMap(({ next }) =>
    typeof next === 'string' ? [next] : [...Object.values(next.cases), next.otherwise],
  );
}

/** A call enters nodes from the start, the global intents and the idle ending, nowhere else. */
function unreachableNodes(flow: FlowDocument): string[] {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const listen = flow.nodes[id]!.listen;
    if (listen) flowTargets(flow, listen).forEach(visit);
  };
  [flow.start, flow.idle.end, ...Object.values(flow.globalIntents).flatMap((g) => g.next ?? [])]
    .filter((id): id is string => typeof id === 'string')
    .forEach(visit);
  return Object.keys(flow.nodes).filter((id) => !seen.has(id));
}
