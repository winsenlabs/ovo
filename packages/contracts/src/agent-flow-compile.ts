import {
  FLOW_INTENT_QUESTION,
  FLOW_OTHER_INTENT,
  type AgentFlow,
  type FlowIntent,
  type FlowListen,
  type FlowNode,
} from './agent-flow.ts';
import {
  FLOW_INSTRUCTIONS_LIMIT,
  flowListenInstructions,
  routeTargets,
} from './agent-flow-queries.ts';
import { reachable, verificationListens } from './agent-flow-reach.ts';
import { normalizeForMatch } from './text.ts';

export * from './agent-flow-queries.ts';

/**
 * Graph checks for an authored flow. Pure: the release check reports the issues as blockers, the
 * console shows them while editing, and the runtime refuses to start a flow that has any error.
 */

export interface FlowIssue {
  severity: 'error' | 'warning';
  /** Dotted path inside the flow, such as `nodes.3.say.1`. */
  path: string;
  message: string;
}

export interface CompiledFlow {
  flow: AgentFlow;
  nodes: ReadonlyMap<string, FlowNode>;
  listens: ReadonlyMap<string, FlowListen>;
  /** True when some node confirms identity, so the call's facts wait until one is entered. */
  gatesIdentity: boolean;
  /**
   * Listen sets reachable before any identity-confirming node. Until identity is confirmed, the
   * LLM fallback may only resume at one of these, so it can never talk its way past verification.
   */
  preVerificationListens: ReadonlySet<string>;
  /**
   * Listen sets reachable from an identity-confirming node. Once identity is confirmed the LLM
   * fallback resumes only at these: handing the call back to "am I speaking with…?" would ask the
   * caller who they are again.
   */
  postVerificationListens: ReadonlySet<string>;
  /**
   * Per listen set, each normalised phrase of its own intents and the global ones, to the intent
   * key it means, so the instant tier normalises the reply once and looks it up (`matchFlowPhrase`)
   * instead of normalising every phrase of every intent on every turn.
   */
  phrases: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export class FlowCompileError extends Error {
  constructor(readonly issues: readonly FlowIssue[]) {
    super(`Invalid flow: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    this.name = 'FlowCompileError';
  }
}

export function inspectFlow(flow: AgentFlow): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });
  const nodes = firstById(flow.nodes, 'nodes', error, 'Node');
  const listens = firstById(flow.listens, 'listens', error, 'Listen set');
  const lines = new Set(Object.keys(flow.lines));
  const usedLines = new Set<string>();
  const usedListens = new Set<string>();
  const line = (path: string, id: string | undefined) => {
    if (id === undefined) return;
    usedLines.add(id);
    if (!lines.has(id)) error(path, `Line ${id} does not exist`);
  };

  if (!nodes.has(flow.start)) error('start', `Start node ${flow.start} does not exist`);
  line('clarify', flow.clarify);
  line('repeatPrefix', flow.repeatPrefix);
  line('holdPrefix', flow.holdPrefix);
  flow.nodes.forEach((node, index) => {
    const at = `nodes.${index}`;
    node.say.forEach((id, lineIndex) => line(`${at}.say.${lineIndex}`, id));
    node.mandatory?.forEach((id, lineIndex) => {
      if (!node.say.includes(id))
        error(`${at}.mandatory.${lineIndex}`, `Line ${id} is not one the node says`);
    });
    if (node.end && node.listen !== undefined)
      error(`${at}.listen`, 'A node that ends the call does not listen');
    if (!node.end && node.listen === undefined)
      error(`${at}.listen`, 'A node that does not end the call needs a listen set');
    if (node.listen !== undefined) {
      usedListens.add(node.listen);
      if (!listens.has(node.listen))
        error(`${at}.listen`, `Listen set ${node.listen} does not exist`);
    }
  });

  const globalKeys = new Set(flow.globalIntents.map((intent) => intent.key));
  checkIntents(flow.globalIntents, 'globalIntents', undefined, nodes, error);
  flow.listens.forEach((listen, index) => {
    const at = `listens.${index}`;
    const instructions = flowListenInstructions(flow, listen).length;
    if (instructions > FLOW_INSTRUCTIONS_LIMIT)
      error(
        `${at}.question`,
        `The context and this question together are ${instructions} characters; the decision ` +
          `model reads at most ${FLOW_INSTRUCTIONS_LIMIT}`,
      );
    const slotIds = new Set<string>();
    listen.slots.forEach((slot, slotIndex) => {
      if (slot.id === FLOW_INTENT_QUESTION)
        error(`${at}.slots.${slotIndex}.id`, `Slot id ${FLOW_INTENT_QUESTION} is reserved`);
      if (slotIds.has(slot.id)) error(`${at}.slots.${slotIndex}.id`, `Duplicate slot ${slot.id}`);
      slotIds.add(slot.id);
      const options = slot.options.map((option) => option.key);
      if (new Set(options).size !== options.length)
        error(`${at}.slots.${slotIndex}.options`, `Duplicate option in slot ${slot.id}`);
    });
    checkIntents(listen.intents, `${at}.intents`, listen, nodes, error);
    listen.intents.forEach((intent, intentIndex) => {
      if (globalKeys.has(intent.key))
        error(
          `${at}.intents.${intentIndex}.key`,
          `Intent ${intent.key} is also a global intent; the model could not tell them apart`,
        );
    });
    checkPhrases([...listen.intents, ...flow.globalIntents], `${at}.intents`, error);
    if (!usedListens.has(listen.id)) warn(`${at}`, `No node listens with ${listen.id}`);
  });
  checkPhrases(flow.globalIntents, 'globalIntents', error);

  for (const id of lines) if (!usedLines.has(id)) warn(`lines.${id}`, `Line ${id} is never spoken`);
  if (nodes.has(flow.start)) {
    const reached = reachable(flow, nodes, listens, () => true);
    flow.nodes.forEach((node, index) => {
      if (!reached.has(node.id))
        error(`nodes.${index}`, `Node ${node.id} cannot be reached from ${flow.start}`);
    });
  }
  return issues;
}

/** Compile a flow for the runtime. Any error-level issue throws: a release check missed it. */
export function compileFlow(flow: AgentFlow): CompiledFlow {
  const errors = inspectFlow(flow).filter((issue) => issue.severity === 'error');
  if (errors.length) throw new FlowCompileError(errors);
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const listens = new Map(flow.listens.map((listen) => [listen.id, listen]));
  const { before, after } = verificationListens(flow, nodes, listens);
  return {
    flow,
    nodes,
    listens,
    gatesIdentity: flow.nodes.some((node) => node.verified),
    preVerificationListens: before,
    postVerificationListens: after,
    phrases: new Map(
      flow.listens.map((listen) => [
        listen.id,
        phraseIntents([...listen.intents, ...flow.globalIntents]),
      ]),
    ),
  };
}

/**
 * The listen set's intents come first, so the first owner of a phrase keeps it, as the linear scan
 * this replaces did; `checkPhrases` already refuses a phrase that means two intents.
 */
function phraseIntents(intents: readonly FlowIntent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const intent of intents)
    for (const phrase of intent.phrases) {
      const normalized = normalizeForMatch(phrase);
      if (normalized && !map.has(normalized)) map.set(normalized, intent.key);
    }
  return map;
}

function firstById<T extends { id: string }>(
  items: readonly T[],
  path: string,
  error: (path: string, message: string) => void,
  what: string,
): Map<string, T> {
  const map = new Map<string, T>();
  items.forEach((item, index) => {
    if (map.has(item.id)) error(`${path}.${index}.id`, `${what} id ${item.id} is used twice`);
    else map.set(item.id, item);
  });
  return map;
}

function checkIntents(
  intents: readonly FlowIntent[],
  path: string,
  listen: FlowListen | undefined,
  nodes: ReadonlyMap<string, FlowNode>,
  error: (path: string, message: string) => void,
): void {
  const keys = new Set<string>();
  intents.forEach((intent, index) => {
    const at = `${path}.${index}`;
    if (intent.key === FLOW_OTHER_INTENT)
      error(`${at}.key`, `Intent ${FLOW_OTHER_INTENT} is added automatically and is reserved`);
    if (keys.has(intent.key)) error(`${at}.key`, `Duplicate intent ${intent.key}`);
    keys.add(intent.key);
    const routes = [intent.next !== undefined, intent.repeat === true, intent.hold === true];
    if (routes.filter(Boolean).length !== 1)
      error(at, 'An intent needs exactly one of `next`, `repeat` or `hold`');
    const route = intent.next;
    if (route !== undefined && typeof route !== 'string') {
      const slot = listen?.slots.find((candidate) => candidate.id === route.slot);
      if (!slot) error(`${at}.next.slot`, `Slot ${route.slot} is not asked in this listen set`);
      else
        for (const option of Object.keys(route.cases))
          if (!slot.options.some((candidate) => candidate.key === option))
            error(`${at}.next.cases.${option}`, `Slot ${slot.id} has no option ${option}`);
    }
    for (const target of routeTargets(route))
      if (!nodes.has(target)) error(`${at}.next`, `Node ${target} does not exist`);
  });
}

/** The same whole reply on two intents would make the instant tier depend on authoring order. */
function checkPhrases(
  intents: readonly FlowIntent[],
  path: string,
  error: (path: string, message: string) => void,
): void {
  const owner = new Map<string, string>();
  for (const intent of intents)
    for (const phrase of intent.phrases) {
      const normalized = normalizeForMatch(phrase);
      if (!normalized) {
        error(path, `Phrase "${phrase}" of ${intent.key} has no letters or digits`);
        continue;
      }
      const previous = owner.get(normalized);
      if (previous !== undefined && previous !== intent.key)
        error(path, `Phrase "${phrase}" means both ${previous} and ${intent.key}`);
      owner.set(normalized, intent.key);
    }
}
