import {
  normalizeUtterance,
  parseFlowDocument,
  templateVariables,
  type FlowDocument,
  type FlowGlobalIntent,
  type FlowIntent,
  type FlowListen,
  type FlowNext,
  type FlowNode,
  type FlowRules,
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
  name: string;
  /** The decision preamble. The POC keeps it in `lib/jev.js`, outside the flow module. */
  context: string;
  /** Config variables (`agent`, `helpline`) spoken the same on every call, inlined into the lines. */
  constants?: Record<string, string>;
  start?: string;
  source?: Record<string, string>;
}

/** The POC's conventions in `lib/call.js`: these lines and nodes are not named in `NODES`. */
const RECOVERY = {
  repeatPrefix: 'repeat_prefix',
  didntCatch: 'didnt_catch',
  idlePrompt: 'no_input',
  idleEnd: 'no_input_end',
};

/** `{name}` becomes `{{name}}`; a constant is written into the line instead. */
export function convertTemplate(text: string, constants: Record<string, string> = {}): string {
  return text.replace(/\{(\w+)\}/g, (_, name: string) =>
    Object.hasOwn(constants, name) ? constants[name]! : `{{${name}}}`,
  );
}

export function importPocFlow(poc: PocFlowModule, options: PocImportOptions): FlowDocument {
  const constants = options.constants ?? {};
  const lines = Object.fromEntries(
    Object.entries(poc.CLIPS).map(([id, text]) => [id, convertTemplate(text, constants)]),
  );
  const variables = [...new Set(Object.values(lines).flatMap(templateVariables))];
  const flow: FlowDocument = {
    version: 1,
    name: options.name,
    context: options.context,
    start: options.start ?? 'greet',
    variables,
    lines,
    nodes: Object.fromEntries(Object.entries(poc.NODES).map(([id, node]) => [id, toNode(node)])),
    listens: Object.fromEntries(
      Object.entries(poc.LISTENS).map(([id, listen]) => [id, toListen(id, listen)]),
    ),
    globalIntents: Object.fromEntries(
      Object.entries(poc.GLOBAL_INTENTS).map(([key, intent]) => [key, toGlobal(key, intent)]),
    ),
    other: { description: poc.OTHER_DESC },
    idle: { prompts: [RECOVERY.idlePrompt], end: RECOVERY.idleEnd },
    recovery: {
      repeatPrefix: RECOVERY.repeatPrefix,
      didntCatch: RECOVERY.didntCatch,
      fillers: poc.FILLERS ?? [],
    },
    ...(options.source ? { source: options.source } : {}),
  };
  return parseFlowDocument(flow);
}

function toNode(node: PocFlowModule['NODES'][string]): FlowNode {
  return {
    say: [...node.say],
    ...(node.end ? { end: true as const } : { listen: node.listen! }),
    ...(node.log ? { disposition: node.log } : {}),
    ...(node.sms ? { actions: [`send_sms:${node.sms}`] } : {}),
    ...(node.verified ? { verified: true as const } : {}),
  };
}

function toListen(id: string, listen: PocFlowModule['LISTENS'][string]): FlowListen {
  const slots = listen.slots ?? {};
  const intents: Record<string, FlowIntent> = {};
  for (const [key, intent] of Object.entries(listen.intents))
    intents[key] = {
      description: intent.desc,
      ...rules(intent.rule),
      next: toNext(`${id}.${key}`, intent.next, slots),
    };
  return {
    question: listen.question,
    intents,
    ...(listen.slots
      ? {
          slots: Object.fromEntries(
            Object.entries(slots).map(([slot, { question, options }]) => [
              slot,
              { question, options: { ...options } },
            ]),
          ),
        }
      : {}),
  };
}

function toGlobal(key: string, intent: PocFlowModule['GLOBAL_INTENTS'][string]): FlowGlobalIntent {
  if (!intent.next && key !== 'repeat')
    throw new Error(`Global intent ${key} has no next node and is not the repeat intent`);
  return {
    description: intent.desc,
    ...rules(intent.rule),
    ...(intent.next ? { next: intent.next } : { repeat: true as const }),
  };
}

function rules(rule: PocRule | undefined): { rules?: FlowRules } {
  if (!rule) return {};
  const phrases = (Array.isArray(rule) ? rule : [rule]).flatMap(regexPhrases);
  // A rule is tested against the normalized utterance, so a phrase that normalizes differently
  // could never match; it is a bug in the source rule, not something to import silently.
  const dead = phrases.filter((phrase) => normalizeUtterance(phrase) !== phrase);
  if (dead.length) throw new Error(`Rule phrases can never match: ${dead.join(', ')}`);
  return { rules: { phrases: [...new Set(phrases)] } };
}

/**
 * A POC `next` written as code is turned into a decision table by asking it once per option of each
 * slot of its listen. It must depend on at most one slot; anything else cannot become data.
 */
function toNext(
  where: string,
  next: PocNext,
  slots: Record<string, { options: object }>,
): FlowNext {
  if (typeof next === 'string') return next;
  const target = (answers: Record<string, string>) => {
    const value = next(answers);
    if (typeof value !== 'string') throw new Error(`${where}: next() returned no node`);
    return value;
  };
  const otherwise = target({});
  const tables = Object.entries(slots)
    .map(([slot, { options }]) => ({
      slot,
      cases: Object.fromEntries(Object.keys(options).map((o) => [o, target({ [slot]: o })])),
    }))
    .filter(({ cases }) => Object.values(cases).some((value) => value !== otherwise));
  if (tables.length > 1) throw new Error(`${where}: next() depends on more than one slot`);
  return tables.length ? { ...tables[0]!, otherwise } : otherwise;
}
