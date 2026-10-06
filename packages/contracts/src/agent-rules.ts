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
/** Unbounded quantifiers allowed in one pattern, which bounds backtracking on short input. */
const MAX_REPEATS = 3;

/**
 * Why a rule pattern is refused, or undefined when it is safe to run on a caller's words. Patterns
 * run on every turn of every call, so anything that can backtrack exponentially is refused at
 * authoring time: backreferences, lookbehind, and a repeated group that itself repeats or
 * alternates (`(a+)+`, `(yes|yeah)*`). Input is capped at RULE_INPUT_MAX_CHARS as well.
 */
export function unsafeRulePattern(pattern: string): string | undefined {
  try {
    new RegExp(pattern, 'u');
  } catch {
    return 'is not a valid regular expression';
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'uses a backreference';
  if (/\(\?<[=!]/.test(pattern)) return 'uses a lookbehind';
  const groups: { repeats: boolean }[] = [];
  let repeats = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') {
      // A class is one character; skip to its unescaped closing bracket.
      for (index += 1; index < pattern.length && pattern[index] !== ']'; index += 1)
        if (pattern[index] === '\\') index += 1;
      continue;
    }
    const kind = quantifier(pattern, index);
    if (char === '(') groups.push({ repeats: false });
    else if (char === '|' && groups.length) groups.at(-1)!.repeats = true;
    else if (kind) {
      if (kind === 'unbounded') repeats += 1;
      for (const group of groups) group.repeats = true;
    } else if (char === ')') {
      const group = groups.pop();
      if (group?.repeats && quantifier(pattern, index + 1))
        return 'repeats a group that itself repeats or alternates';
      if (group?.repeats && groups.length) groups.at(-1)!.repeats = true;
    }
  }
  if (repeats > MAX_REPEATS) return `uses more than ${MAX_REPEATS} unbounded repeats`;
  return undefined;
}

/** `?` is not a repeat: it matches at most once. `{n,m}` above 20 counts as unbounded. */
function quantifier(pattern: string, index: number): 'bounded' | 'unbounded' | undefined {
  const char = pattern[index];
  if (char === '*' || char === '+') return 'unbounded';
  if (char !== '{') return undefined;
  const brace = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
  if (!brace) return undefined;
  if (brace[2] === undefined) return 'bounded';
  return brace[3] === '' || Number(brace[3]) > 20 ? 'unbounded' : 'bounded';
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
  .strict();
export type AgentRules = z.infer<typeof AgentRules>;

/** Splits a flat-agent rule target into its decision question and answer. */
export function ruleDecisionTarget(intent: string): { question: string; answer: string } | null {
  const at = intent.indexOf('=');
  return at < 0 ? null : { question: intent.slice(0, at), answer: intent.slice(at + 1) };
}
