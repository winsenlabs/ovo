import {
  agentLanguageLine,
  baseLanguageOf,
  languageVerdict,
  type AgentConfig,
} from '@winsendotai/ovo-contracts';

/** One reply's language check (see `CallLanguages.reply`). */
export interface ReplyLanguageGuard {
  /** The segment to speak, the agent's language line in its place, or undefined to drop it. */
  check(segment: string): string | undefined;
  /**
   * The reply left the agent's languages: the line replaced it, so nothing else it decided (an
   * `end_call`) may stand.
   */
  readonly replaced: boolean;
}

/** Per-call counters, read when the call ends. */
export class LanguageGuardMetrics {
  /** Caller turns heard outside the agent's languages and answered with its line. */
  offTurns = 0;
  /** Replies the LLM began in another language, replaced by the line. */
  replacedReplies = 0;
  /** Sentences dropped after such a reply was replaced. */
  droppedSegments = 0;

  snapshot() {
    return {
      offTurns: this.offTurns,
      replacedReplies: this.replacedReplies,
      droppedSegments: this.droppedSegments,
    };
  }
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    // swallow-ok: an unnamed code is still a code the model reads.
    return code;
  }
}

/**
 * The platform's reply-language instruction for the LLM (N4): the agent's language, whatever the
 * caller speaks. Undefined without a language policy. Fixed for the call, so it never moves the
 * prompt's cached prefix.
 */
export function replyLanguageNote(
  config: Pick<AgentConfig, 'language' | 'languages'>,
): string | undefined {
  if (!config.languages) return undefined;
  const own = languageName(baseLanguageOf(config.language));
  const others = config.languages.allowed
    .filter((code) => code !== baseLanguageOf(config.language))
    .map(languageName);
  return [
    `Always reply in ${own}, the language of this call, whatever language the caller uses.`,
    others.length
      ? `Callers may mix in ${others.join(', ')}; understand it, but answer in ${own}.`
      : '',
    'Never reply in any other language.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * N4/P9: an agent's `languages` across one call. Inert (every method passes through) for an agent
 * without them.
 *
 * - The caller's words, when mostly in another language (an STT that drifted, a background
 *   talker), are not understood: the turn is answered with the agent's language line, and neither
 *   the decision model nor the LLM sees them, so neither can act or end the call on them.
 * - The LLM is told, by the platform rather than the persona prompt, to reply in the agent's
 *   language whatever the caller speaks (`note`).
 * - A reply that still leaves the allowed languages is never spoken: its first such sentence
 *   becomes the line (or is dropped once the reply has said something), and the rest is dropped.
 */
export class CallLanguages {
  readonly metrics = new LanguageGuardMetrics();
  /** Said instead of an answer to words outside the agent's languages. */
  readonly line?: string;
  /** The reply-language instruction appended to the LLM's context. */
  readonly note?: string;
  private readonly allowed?: readonly string[];

  constructor(config: Pick<AgentConfig, 'language' | 'languages'>) {
    const line = agentLanguageLine(config);
    if (!config.languages || line === undefined) return;
    this.allowed = config.languages.allowed;
    this.line = line;
    this.note = replyLanguageNote(config);
  }

  /** True when the caller's words are mostly outside the agent's languages; counts the turn. */
  offLanguage(input: string): boolean {
    if (this.understands(input)) return false;
    this.metrics.offTurns += 1;
    return true;
  }

  /** False when the words are mostly outside the agent's languages; counts nothing. */
  understands(input: string): boolean {
    return !this.allowed || !languageVerdict(input, this.allowed).off;
  }

  /**
   * One reply's check, run before `inner` (the reply guardrail) on every sentence the reply
   * speaks. Undefined without a language policy.
   */
  reply(inner?: (segment: string) => string | undefined): ReplyLanguageGuard | undefined {
    const allowed = this.allowed;
    const line = this.line;
    if (!allowed || line === undefined) return undefined;
    const metrics = this.metrics;
    let replaced = false;
    let spoke = false;
    return {
      get replaced() {
        return replaced;
      },
      check(segment) {
        if (replaced) {
          metrics.droppedSegments += 1;
          return undefined;
        }
        if (languageVerdict(segment, allowed).off) {
          replaced = true;
          metrics.replacedReplies += 1;
          return spoke ? undefined : line;
        }
        const kept = inner ? inner(segment) : segment;
        if (kept !== undefined) spoke = true;
        return kept;
      },
    };
  }
}
