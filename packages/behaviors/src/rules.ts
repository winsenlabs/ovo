import {
  RULE_INPUT_MAX_CHARS,
  type AgentRules,
  type IntentRule,
  type RuleLexicon,
} from '@winsendotai/ovo-contracts';
import { normalizeUtterance, RULE_LEXICON_PATTERNS } from './rules-lexicons.ts';

export interface RuleMatch {
  /** The authored target: a flow intent, or `<question>=<answer>` without a flow. */
  intent: string;
  /** Where the rule was authored: the listen set's own rules, or the global ones. */
  source: 'listen' | 'global';
  by: 'phrase' | 'keyword' | 'pattern' | 'lexicon';
}

interface CompiledRule {
  intent: string;
  phrases: ReadonlySet<string>;
  keywords: readonly string[];
  patterns: readonly RegExp[];
  lexicons: readonly RuleLexicon[];
  maxWords: number;
}

/**
 * The instant rules tier (AGT-6): authored rules matched on the caller's whole normalised reply,
 * in memory, before any network call. Patterns were checked for catastrophic backtracking when the
 * config was parsed; they are compiled once here, anchored, and only ever see short input.
 */
export class RuleMatcher {
  private readonly global: CompiledRule[];
  private readonly listens: ReadonlyMap<string, CompiledRule[]>;

  constructor(private readonly rules: AgentRules) {
    this.global = rules.global.map(compile);
    this.listens = new Map(
      Object.entries(rules.listens).map(([listen, list]) => [listen, list.map(compile)]),
    );
  }

  /** The first rule that matches: the listen set's own, then the global ones, in authored order. */
  match(text: string, listen?: string): RuleMatch | undefined {
    return this.matches(text, listen)[0];
  }

  /** Every matching rule, in the order `match` would pick them. */
  matches(text: string, listen?: string): RuleMatch[] {
    if (!this.rules.enabled) return [];
    const normalized = normalizeUtterance(text);
    if (!normalized || normalized.length > RULE_INPUT_MAX_CHARS) return [];
    const found: RuleMatch[] = [];
    const scan = (rules: readonly CompiledRule[], source: RuleMatch['source']) => {
      for (const rule of rules) {
        const by = matchRule(rule, normalized);
        if (by) found.push({ intent: rule.intent, source, by });
      }
    };
    if (listen !== undefined) scan(this.listens.get(listen) ?? [], 'listen');
    scan(this.global, 'global');
    return found;
  }
}

/** True when the reply is exactly one of the lexicon's entries. */
export function matchesLexicon(lexicon: RuleLexicon, text: string): boolean {
  const normalized = normalizeUtterance(text);
  return (
    normalized.length > 0 &&
    normalized.length <= RULE_INPUT_MAX_CHARS &&
    RULE_LEXICON_PATTERNS[lexicon].test(normalized)
  );
}

function compile(rule: IntentRule): CompiledRule {
  return {
    intent: rule.intent,
    phrases: new Set(rule.phrases.map(normalizeUtterance).filter(Boolean)),
    keywords: rule.keywords.map(normalizeUtterance).filter(Boolean),
    patterns: rule.patterns.map((pattern) => new RegExp(`^(?:${pattern})$`, 'u')),
    lexicons: rule.lexicons,
    maxWords: rule.maxWords,
  };
}

function matchRule(rule: CompiledRule, normalized: string): RuleMatch['by'] | undefined {
  if (rule.phrases.has(normalized)) return 'phrase';
  if (rule.lexicons.some((lexicon) => RULE_LEXICON_PATTERNS[lexicon].test(normalized)))
    return 'lexicon';
  if (rule.patterns.some((pattern) => pattern.test(normalized))) return 'pattern';
  if (
    rule.keywords.length &&
    normalized.split(' ').length <= rule.maxWords &&
    rule.keywords.some((keyword) => ` ${normalized} `.includes(` ${keyword} `))
  )
    return 'keyword';
  return undefined;
}
