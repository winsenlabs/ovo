import {
  AgentConfig as AgentConfigSchema,
  type AgentConfig,
  type Behavior,
} from '@winsendotai/ovo-contracts';

const NEGATIONS = new Set([
  'aint',
  'cannot',
  'cant',
  'didnt',
  'doesnt',
  'dont',
  'never',
  'no',
  'none',
  'not',
  'nothing',
  'wont',
  'without',
]);
const FILLER = new Set([
  'a',
  'an',
  'are',
  'do',
  'does',
  'i',
  'is',
  'my',
  'please',
  'the',
  'to',
  'what',
  'when',
  'where',
]);

export interface FaqCandidateEvidence {
  id: string;
  phrase: string;
  score: number;
  negationMismatch: boolean;
}

export type FaqMatch =
  | {
      kind: 'answer';
      id: string;
      answer: string;
      score: number;
      margin: number;
      evidence: FaqCandidateEvidence[];
    }
  | {
      kind: 'clarify';
      reason: 'no-match' | 'below-threshold' | 'ambiguous' | 'requires-tool';
      evidence: FaqCandidateEvidence[];
      toolId?: string;
    };

export class FaqBehavior implements Behavior {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = AgentConfigSchema.parse(config);
    if (this.config.mode !== 'faq') {
      throw new TypeError(`FAQ behavior requires faq mode, received ${this.config.mode}`);
    }
  }

  async respond(input: string): Promise<string> {
    const result = this.match(input);
    return result.kind === 'answer' ? result.answer : this.config.clarification;
  }

  match(input: string): FaqMatch {
    const query = tokenize(input, this.config.locale);
    if (query.tokens.length === 0) return { kind: 'clarify', reason: 'no-match', evidence: [] };

    const evidence = this.config.faq
      .map((entry) => {
        const phrases = [entry.question, ...entry.aliases];
        let best: FaqCandidateEvidence = {
          id: entry.id,
          phrase: entry.question,
          score: 0,
          negationMismatch: false,
        };
        for (const phrase of phrases) {
          const candidate = tokenize(phrase, this.config.locale);
          const negationMismatch = query.negated !== candidate.negated;
          const exact = query.normalized === candidate.normalized;
          const score = negationMismatch ? 0 : exact ? 1 : dice(query.tokens, candidate.tokens);
          if (score > best.score) best = { id: entry.id, phrase, score, negationMismatch };
          else if (negationMismatch && best.score === 0)
            best = { id: entry.id, phrase, score, negationMismatch };
        }
        return best;
      })
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

    const first = evidence[0];
    if (!first || first.score === 0) return { kind: 'clarify', reason: 'no-match', evidence };
    if (first.score < this.config.faqThreshold)
      return { kind: 'clarify', reason: 'below-threshold', evidence };

    const second = evidence[1];
    const margin = first.score - (second?.score ?? 0);
    if (second && margin < this.config.faqMargin)
      return { kind: 'clarify', reason: 'ambiguous', evidence };

    const selected = this.config.faq.find((entry) => entry.id === first.id)!;
    if (selected.requiresTool) {
      return { kind: 'clarify', reason: 'requires-tool', evidence, toolId: selected.requiresTool };
    }
    return {
      kind: 'answer',
      id: selected.id,
      answer: selected.answer,
      score: first.score,
      margin,
      evidence,
    };
  }
}

export function createFaqBehavior(config: AgentConfig): FaqBehavior {
  return new FaqBehavior(config);
}

function tokenize(
  input: string,
  locale: string,
): { normalized: string; tokens: string[]; negated: boolean } {
  const normalized = input
    .normalize('NFKC')
    .toLocaleLowerCase(locale)
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const raw = normalized ? normalized.split(' ') : [];
  const negated = raw.some((token) => NEGATIONS.has(token));
  const informative = raw.filter((token) => !FILLER.has(token));
  return { normalized, tokens: unique(informative.length ? informative : raw), negated };
}

function dice(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const intersection = left.filter((token) => rightSet.has(token)).length;
  return (2 * intersection) / (left.length + right.length);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
