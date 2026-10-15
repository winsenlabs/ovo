import type { RoutingHost, RulesMatcher, RoutingEngine } from '@winsendotai/ovo-contracts';
import { isOpen } from '../hours.ts';
import { normalizeText, scriptShare, words } from '../text.ts';
import type { EngineInput, EngineResult, EngineRunner, RouteTurn } from './types.ts';

type RulesEngine = Extract<RoutingEngine, { kind: 'rules' }>;

/** What a rule may read besides the turn: the call's caller id and variables, and the clock. */
export type RulesEnv = Pick<RoutingHost, 'call' | 'now'>;

/** Matchers that read the call or the clock, never the caller's turn. */
const INSTANT = new Set<RulesMatcher['kind']>(['caller-id', 'time', 'variable']);

/** A rule made only of instant matchers can decide on the opening, before the caller speaks. */
export function hasInstantRule(engine: RulesEngine): boolean {
  return engine.rules.some((rule) => rule.when.every((matcher) => INSTANT.has(matcher.kind)));
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1)
    if (needle.every((word, index) => haystack[start + index] === word)) return true;
  return false;
}

function variableText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Whether one matcher holds. A matcher that reads the turn never holds without one. */
export function matches(
  matcher: RulesMatcher,
  turn: RouteTurn | undefined,
  env: RulesEnv,
): boolean {
  switch (matcher.kind) {
    case 'dtmf':
      return turn?.digits === matcher.digits;
    case 'caller-id': {
      const from = env.call.from;
      return from !== undefined && matcher.prefixes.some((prefix) => from.startsWith(prefix));
    }
    case 'time':
      return isOpen(matcher.hours, env.now()) === matcher.inside;
    case 'variable': {
      const value = variableText(env.call.variables[matcher.name]);
      return value !== undefined && matcher.equals.includes(value);
    }
    case 'keywords': {
      if (turn?.text === undefined) return false;
      const said = words(turn.text);
      if (!said.length || said.length > matcher.maxWords) return false;
      return matcher.words.some((word) => containsSequence(said, words(word)));
    }
    case 'phrases': {
      if (turn?.text === undefined) return false;
      const said = normalizeText(turn.text);
      return said !== '' && matcher.phrases.some((phrase) => normalizeText(phrase) === said);
    }
    case 'script':
      return turn?.text !== undefined && scriptShare(turn.text, matcher.languages) > 0.5;
  }
}

/**
 * The rules engine (§7.6): rules in order, every matcher of a rule must hold, the first rule that
 * holds names its branch with confidence 1. A rule naming a branch the node lacks is skipped (the
 * publish validator refuses it as `routing_rule_branch_unknown`). A clock or zone failure is an
 * `error`, so the next engine runs.
 */
export function createRulesRunner(env: RulesEnv): EngineRunner<'rules'> {
  return async (engine: RulesEngine, input: EngineInput): Promise<EngineResult> => {
    const branches = new Set(input.node.branches.map((branch) => branch.key));
    try {
      for (const rule of engine.rules)
        if (
          branches.has(rule.branch) &&
          rule.when.every((matcher) => matches(matcher, input.turn, env))
        )
          return { outcome: 'matched', branch: rule.branch, confidence: 1 };
    } catch {
      return { outcome: 'error', reason: 'rules_failed' };
    }
    return { outcome: 'no_match' };
  };
}
