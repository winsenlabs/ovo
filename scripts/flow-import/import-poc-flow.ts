import { normalizeForMatch } from '../../packages/contracts/src/text.ts';
import {
  checkFlow,
  FLOW_OTHER_DESCRIPTION,
  templateVariables,
  type AgentFlow,
  type FlowIntent,
  type FlowListen,
  type FlowNode,
  type FlowRoute,
  type FlowSlot,
} from '../../packages/plugin-evaluations/src/jev-eval-flow.ts';
import { regexPhrases } from './regex-phrases.ts';

/** The exports of a POC `lib/flow.js` the importer reads. Rules are regexes, `next` may be code. */
type PocRule = RegExp | RegExp[];
type PocNext = string | ((slots: Record<string, string>) => string | undefined);
export interface PocFlowModule {
  CLIPS: Record<string, string>;
  NODES: Record<
    string,
    {
      say: string[];
      listen?: string;
      end?: boolean;
      log?: string;
      sms?: string;
      verified?: boolean;
    }
  >;
  LISTENS: Record<
    string,
    {
      question: string;
      intents: Record<string, { desc: string; rule?: PocRule; next: PocNext }>;
      slots?: Record<string, { question: string; options: Record<string, string> }>;
    }
  >;
  GLOBAL_INTENTS: Record<string, { desc: string; rule?: PocRule; next?: string }>;
  OTHER_DESC: string;
  FILLERS?: string[];
}

export interface PocImportOptions {
  /** The decision preamble. The POC keeps it in `lib/jev.js`, outside the flow module. */
  context: string;
  /** Config variables (`agent`, `helpline`) spoken the same on every call, inlined into the lines. */
  constants?: Record<string, string>;
  start?: string;
  /** The POC's `JEV_MIN_CONFIDENCE` (0.55 by default). */
  threshold?: number;
  /**
   * OVO's own changes on top of the imported map, made to the flow before it is checked: what
   * live calls taught that the POC does not have. Returns the ids of the lines it adds, which the
   * POC's conversation map cannot list.
   */
  adjust?: (flow: AgentFlow) => string[];
}

/**
 * The agent-config fields an import fills, ready to merge into an agent: the flow (authored inside
 * the decision policy, as the flow lane's contract has it), the silence handling, and `variables`.
 */
export interface ImportedFlowConfig {
  decision: { enabled: true; flow: AgentFlow };
  /** The jevonly lane's `AgentIdle`: one prompt per silence, then the closing line. */
  idle: { prompts: string[]; finalLine: string };
  variables: {
    type: 'object';
    required: string[];
    properties: Record<string, { type: 'string' }>;
    additionalProperties: false;
  };
}

/** The POC's conventions in `lib/call.js`: these lines and nodes are not named in `NODES`. */
const RECOVERY = { repeatPrefix: 'repeat_prefix', clarify: 'didnt_catch' };
const IDLE = { prompt: 'no_input', end: 'no_input_end' };
/** The POC node a second silence enters. It becomes `idle.finalLine`, not a flow node. */
export const IDLE_END_NODE = IDLE.end;

/**
 * The POC strips punctuation (`that's` → `thats`); OVO's `normalizeForMatch` turns it into a space
 * (`that s`). A rule written for the POC therefore also gets the spelling a transcript with an
 * apostrophe normalizes to, or "that's all" would stop matching.
 */
const APOSTROPHES: Record<string, string> = {
  thats: 'that s',
  its: 'it s',
  didnt: 'didn t',
  havent: 'haven t',
  dont: 'don t',
  cant: 'can t',
  im: 'i m',
};

/** `{name}` becomes `{{name}}`; a constant is written into the line instead. */
export function convertTemplate(text: string, constants: Record<string, string> = {}): string {
  return text.replace(/\{(\w+)\}/g, (_, name: string) =>
    Object.hasOwn(constants, name) ? constants[name]! : `{{${name}}}`,
  );
}

/**
 * Imports a POC flow module. `notes` lists what the POC does that a flow cannot express yet (SMS
 * side effects, filler clips, the no-input disposition); the import drops those rather than
 * inventing fields for them.
 */
export function importPocFlow(
  poc: PocFlowModule,
  options: PocImportOptions,
): { config: ImportedFlowConfig; notes: string[]; added: string[] } {
  const notes: string[] = [];
  const constants = options.constants ?? {};
  const text = (id: string) => convertTemplate(poc.CLIPS[id]!, constants);
  const idleEnd = poc.NODES[IDLE.end]!;
  const idle = { prompts: [text(IDLE.prompt)], finalLine: idleEnd.say.map(text).join(' ') };
  if (idleEnd.log)
    notes.push(`idle: the POC records ${idleEnd.log}; an idle ending has no disposition`);
  const dropped = new Set([IDLE.prompt, ...idleEnd.say, ...(poc.FILLERS ?? [])]);
  if (poc.FILLERS?.length)
    notes.push(`lines ${poc.FILLERS.join(', ')}: LLM filler clips have no place in a flow`);
  if (poc.OTHER_DESC !== FLOW_OTHER_DESCRIPTION)
    notes.push('other: the POC describes it differently; flows use the built-in description');

  const lines = Object.fromEntries(
    Object.keys(poc.CLIPS)
      .filter((id) => !dropped.has(id))
      .map((id) => [id, text(id)]),
  );
  const nodes: FlowNode[] = Object.entries(poc.NODES)
    .filter(([id]) => id !== IDLE.end)
    .map(([id, node]) => {
      if (node.sms) notes.push(`node ${id}: sends the ${node.sms} SMS; flows have no actions yet`);
      return {
        id,
        say: [...node.say],
        ...(node.end ? {} : { listen: node.listen! }),
        end: node.end === true,
        ...(node.log ? { disposition: node.log } : {}),
        verified: node.verified === true,
      };
    });
  const flow: AgentFlow = {
    version: 1,
    start: options.start ?? 'greet',
    context: options.context,
    lines,
    nodes,
    listens: Object.entries(poc.LISTENS).map(([id, listen]) => toListen(id, listen)),
    globalIntents: Object.entries(poc.GLOBAL_INTENTS).map(([key, intent]) => toGlobal(key, intent)),
    threshold: options.threshold ?? 0.55,
    fallback: 'llm',
    clarify: RECOVERY.clarify,
    repeatPrefix: RECOVERY.repeatPrefix,
  };
  const added = options.adjust?.(flow) ?? [];
  const variables = [...new Set(Object.values(flow.lines).flatMap(templateVariables))];
  checkFlow(flow, variables);
  return {
    config: {
      decision: { enabled: true, flow },
      idle,
      variables: {
        type: 'object',
        required: variables,
        properties: Object.fromEntries(variables.map((name) => [name, { type: 'string' }])),
        additionalProperties: false,
      },
    },
    notes,
    added,
  };
}

function toListen(id: string, listen: PocFlowModule['LISTENS'][string]): FlowListen {
  const slots: FlowSlot[] = Object.entries(listen.slots ?? {}).map(([slot, definition]) => ({
    id: slot,
    question: definition.question,
    options: Object.entries(definition.options).map(([key, description]) => ({ key, description })),
  }));
  return {
    id,
    question: listen.question,
    intents: Object.entries(listen.intents).map(([key, intent]) => ({
      key,
      description: intent.desc,
      phrases: phrases(intent.rule),
      next: toRoute(`${id}.${key}`, intent.next, slots),
    })),
    slots,
  };
}

function toGlobal(key: string, intent: PocFlowModule['GLOBAL_INTENTS'][string]): FlowIntent {
  if (!intent.next && key !== 'repeat')
    throw new Error(`Global intent ${key} has no next node and is not the repeat intent`);
  return {
    key,
    description: intent.desc,
    phrases: phrases(intent.rule),
    ...(intent.next ? { next: intent.next } : { repeat: true }),
  };
}

function phrases(rule: PocRule | undefined): string[] {
  const expanded = (rule === undefined ? [] : Array.isArray(rule) ? rule : [rule]).flatMap(
    regexPhrases,
  );
  const spellings = expanded.flatMap((phrase) => {
    const words = phrase.split(' ');
    const variant = words.map((word) => APOSTROPHES[word] ?? word).join(' ');
    return variant === phrase ? [phrase] : [phrase, variant];
  });
  return [...new Set(spellings.map(normalizeForMatch).filter(Boolean))];
}

/**
 * A POC `next` written as code is turned into a decision table by asking it once per option of each
 * slot of its listen. It must depend on at most one slot; anything else cannot become data.
 */
function toRoute(where: string, next: PocNext, slots: FlowSlot[]): FlowRoute {
  if (typeof next === 'string') return next;
  const target = (answers: Record<string, string>) => {
    const value = next(answers);
    if (typeof value !== 'string') throw new Error(`${where}: next() returned no node`);
    return value;
  };
  const otherwise = target({});
  const tables = slots
    .map((slot) => ({
      slot: slot.id,
      cases: Object.fromEntries(slot.options.map(({ key }) => [key, target({ [slot.id]: key })])),
    }))
    .filter(({ cases }) => Object.values(cases).some((value) => value !== otherwise));
  if (tables.length > 1) throw new Error(`${where}: next() depends on more than one slot`);
  return tables.length ? { ...tables[0]!, otherwise } : otherwise;
}
