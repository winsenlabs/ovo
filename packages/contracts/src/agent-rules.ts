import { z } from 'zod';

/**
 * The instant rules tier (AGT-6): short, common replies ("yes", "haan ji", "speaking", "sorry?")
 * resolved on the caller's whole normalised utterance with no network round trip, before the
 * decision model is asked. Deliberately narrow, as the POC's were: a reply with a qualifier ("yes
 * but not today") matches nothing and goes to the decision model.
 *
 * A rule names the intent it resolves to. With a flow that is an intent of the current listen set
 * (or a global intent); without one it is `<question>=<answer>`, an answer to a decision question,
 * because the decision policy is the only router a flat agent has.
 */

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const Phrase = z.string().trim().min(1).max(200);

/** Built-in multilingual lexicons (English, Hindi, Tamil; native script and romanised). */
export const RULE_LEXICONS = ['yes', 'no', 'speaking', 'thanks', 'bye', 'repeat', 'wait'] as const;
export const RuleLexicon = z.enum(RULE_LEXICONS);
export type RuleLexicon = z.infer<typeof RuleLexicon>;

/** Rules see at most this many characters of normalised speech; longer replies go to the model. */
export const RULE_INPUT_MAX_CHARS = 120;
/** Ways one repeat (`*`, `+`, `{n,}`) can split a reply: any length from 0 to the input cap. */
const SPLITS = RULE_INPUT_MAX_CHARS + 1;
/**
 * The most match paths one pattern may have: two unbounded repeats and four optional parts. On a
 * 120-character reply its worst case runs in a few milliseconds.
 */
export const RULE_PATTERN_MAX_COST = SPLITS ** 2 * 16;
/** The most match paths all the patterns tried on one turn (a listen set plus global) may have. */
export const RULE_TURN_MAX_COST = RULE_PATTERN_MAX_COST * 4;

/**
 * Why a rule pattern is refused, or undefined when it is safe to run on a caller's words. Patterns
 * run synchronously on every turn of every call, so anything that can backtrack far is refused at
 * authoring time: backreferences, lookbehind, a repeated group that itself repeats or alternates
 * (`(a+)+`, `(yes|yeah)*`), and a pattern whose match paths exceed RULE_PATTERN_MAX_COST.
 */
export function unsafeRulePattern(pattern: string): string | undefined {
  const cost = rulePatternCost(pattern);
  if (typeof cost === 'string') return cost;
  if (cost > RULE_PATTERN_MAX_COST) return 'has too many repeats, optional parts or alternatives';
  return undefined;
}

/**
 * An upper bound on the paths a backtracking match of `pattern` can try on a reply of at most
 * RULE_INPUT_MAX_CHARS, or why it cannot be bounded. A sequence multiplies its parts, alternatives
 * add up, `?` doubles, and every quantifier that can match a varying number of times beyond one
 * (`*`, `+`, `{n,}`, `{n,m}`, bounded or not: `.{0,20}` backtracks like `.*`) multiplies by the
 * number of lengths it can take.
 */
export function rulePatternCost(pattern: string): number | string {
  try {
    new RegExp(pattern, 'u');
  } catch {
    return 'is not a valid regular expression';
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'uses a backreference';
  if (/\(\?<[=!]/.test(pattern)) return 'uses a lookbehind';
  let index = 0;

  // Returns the cost of alternatives up to the closing `)` (or the end) and whether any part of
  // them can match more than one way.
  const alternation = (): { cost: number; choices: boolean } | string => {
    let total = 0;
    let choices = false;
    for (;;) {
      const sequence = terms();
      if (typeof sequence === 'string') return sequence;
      total += sequence.cost;
      choices ||= sequence.choices;
      if (pattern[index] !== '|') return { cost: total, choices };
      choices = true;
      index += 1;
    }
  };

  const terms = (): { cost: number; choices: boolean } | string => {
    let cost = 1;
    let choices = false;
    while (index < pattern.length && pattern[index] !== '|' && pattern[index] !== ')') {
      const atom = term();
      if (typeof atom === 'string') return atom;
      const quantified = quantifier(pattern, index);
      if (quantified) {
        index += quantified.length;
        if (pattern[index] === '?') index += 1; // lazy
        if (atom.choices && !quantified.optional)
          return 'repeats a group that itself repeats or alternates';
        // `?` adds the skipped path; any other quantifier repeats a single path, so it splits it.
        cost *= quantified.optional ? 1 + atom.cost : quantified.lengths;
        choices ||= quantified.lengths > 1;
      } else cost *= atom.cost;
      choices ||= atom.choices;
    }
    return { cost, choices };
  };

  const term = (): { cost: number; choices: boolean } | string => {
    const char = pattern[index]!;
    if (char === '\\') {
      // `\u{...}` and `\p{...}` carry a brace that is not a quantifier.
      const brace = /^\\[upP]\{[^}]*\}/.exec(pattern.slice(index));
      index += brace ? brace[0].length : 2;
      return { cost: 1, choices: false };
    }
    if (char === '[') {
      // A class is one character; skip to its unescaped closing bracket.
      for (index += 1; index < pattern.length && pattern[index] !== ']'; index += 1)
        if (pattern[index] === '\\') index += 1;
      index += 1;
      return { cost: 1, choices: false };
    }
    if (char === '(') {
      index += 1;
      const header = /^\?(?::|=|!|<[^>]*>)/.exec(pattern.slice(index));
      if (header) index += header[0].length;
      const inner = alternation();
      index += 1; // `)`
      return inner;
    }
    index += 1;
    return { cost: 1, choices: false };
  };

  const whole = alternation();
  return typeof whole === 'string' ? whole : whole.cost;
}

interface Quantifier {
  /** Characters of source it spans. */
  length: number;
  /** How many repeat counts it allows, capped at SPLITS; an exact `{n}` allows one. */
  lengths: number;
  /** `?` or `{0,1}`: the atom is taken or skipped. */
  optional: boolean;
}

/** The quantifier at `index`, if any. */
function quantifier(pattern: string, index: number): Quantifier | null {
  const char = pattern[index];
  if (char === '?') return { length: 1, lengths: 2, optional: true };
  if (char === '*' || char === '+') return { length: 1, lengths: SPLITS, optional: false };
  if (char !== '{') return null;
  const brace = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
  if (!brace) return null;
  const min = Number(brace[1]);
  const max = brace[2] === undefined ? min : brace[3] === '' ? Infinity : Number(brace[3]);
  return {
    length: brace[0].length,
    lengths: Math.min(max - min + 1, SPLITS),
    optional: min === 0 && max === 1,
  };
}

const Pattern = z
  .string()
  .min(1)
  .max(200)
  .superRefine((pattern, ctx) => {
    const unsafe = unsafeRulePattern(pattern);
    if (unsafe) ctx.addIssue({ code: 'custom', message: `Rule pattern ${unsafe}` });
  });

export const IntentRule = z
  .object({
    /** A flow intent id, or `<question>=<answer>` for an agent without a flow. */
    intent: z.string().regex(/^[a-z][a-z0-9_-]{0,79}(=[a-z][a-z0-9_-]{0,79})?$/),
    /** Exact replies, compared after normalisation (case, punctuation and spacing ignored). */
    phrases: z.array(Phrase).max(200).default([]),
    /** Whole words or phrases anywhere in a reply of at most `maxWords` words. */
    keywords: z.array(Phrase).max(100).default([]),
    /** Regular expressions matched against the whole normalised reply (implicitly anchored). */
    patterns: z.array(Pattern).max(20).default([]),
    lexicons: z.array(RuleLexicon).max(RULE_LEXICONS.length).default([]),
    /** Keywords only match replies this short: a long sentence that contains "yes" is not a yes. */
    maxWords: z.number().int().min(1).max(20).default(4),
  })
  .strict()
  .refine(
    (rule) =>
      rule.phrases.length + rule.keywords.length + rule.patterns.length + rule.lexicons.length > 0,
    { message: 'A rule needs at least one phrase, keyword, pattern or lexicon' },
  );
export type IntentRule = z.infer<typeof IntentRule>;

export const AgentRules = z
  .object({
    enabled: z.boolean().default(true),
    /** Tried after the current listen set's own rules, in every state. */
    global: z.array(IntentRule).max(100).default([]),
    /** Per flow listen set, tried first while the call is in that listen set. */
    listens: z.record(Id, z.array(IntentRule).max(100)).default({}),
  })
  .strict()
  .superRefine((rules, ctx) => {
    // A turn tries the current listen set's patterns and then the global ones, all synchronously.
    const global = patternsCost(rules.global);
    const sets = Object.entries(rules.listens);
    for (const [listen, list] of sets.length ? sets : [['', []] as const]) {
      if (global + patternsCost(list) <= RULE_TURN_MAX_COST) continue;
      ctx.addIssue({
        code: 'custom',
        path: listen ? ['listens', listen] : ['global'],
        message: 'Rule patterns tried on one turn are too costly together; simplify or remove some',
      });
    }
  });
export type AgentRules = z.infer<typeof AgentRules>;

function patternsCost(rules: readonly IntentRule[]): number {
  let total = 0;
  for (const rule of rules)
    for (const pattern of rule.patterns) {
      const cost = rulePatternCost(pattern);
      if (typeof cost === 'number') total += cost;
    }
  return total;
}

/** Splits a flat-agent rule target into its decision question and answer. */
export function ruleDecisionTarget(intent: string): { question: string; answer: string } | null {
  const at = intent.indexOf('=');
  return at < 0 ? null : { question: intent.slice(0, at), answer: intent.slice(at + 1) };
}
