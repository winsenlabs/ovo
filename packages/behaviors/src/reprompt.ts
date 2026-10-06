import {
  AgentRecovery,
  agentRecoveryLines,
  DEFAULT_REPEAT_PREFIX,
  type AgentConfig,
  type JsonSchema,
} from '@winsendotai/ovo-contracts';
import { AnnouncementValidationError, validateTemplatePaths } from './announcement.ts';
import type { DecisionGateResult } from './decision-gate.ts';
import { matchesLexicon } from './rules.ts';
import { normalizeUtterance } from './rules-lexicons.ts';

/** Why a turn is being recovered instead of answered. */
export interface RecoveryMiss {
  reason: 'empty' | 'clarify' | 'unavailable' | 'no-llm';
  /** The listen set, or decision question, that missed: picks its re-ask line. */
  key?: string;
}

/** An authored line and where it is configured. `rendered` text is spoken as it is. */
export interface AuthoredLine {
  field: string;
  text: string;
  rendered?: boolean;
}

/** What to do instead of the answer: lines to speak, and whether they end the call. */
export interface RecoveryPlan {
  lines: AuthoredLine[];
  /** Ends the call once the lines have played, with this completion reason. */
  end?: string;
  /** Idle lines, which the engine speaks as idle prompts. */
  idle?: boolean;
}

/** Where a caller turn goes once the decision step has run. */
export type TurnRoute =
  | { kind: 'recover'; plan: RecoveryPlan }
  /** `say` answers the turn; without it the LLM composes the reply. `end`: `<question>=<answer>`. */
  | { kind: 'answer'; say?: string; end?: string };

/**
 * Repeat, didn't-catch and re-ask lines (AGT-12), the decision-unavailable line (AGT-4), and the
 * bound on them: `maxAttempts` misses in a row, then `exhausted`. Without a `recovery` block only a
 * missing LLM, an empty reply or a configured unavailable line lead here, and the built-in defaults
 * apply; an agent configured as it was before Wave 3 never reaches it.
 */
export class RecoveryState {
  private readonly policy: AgentRecovery;
  private readonly phrases: ReadonlySet<string>;
  private misses = 0;
  private lastTurn?: number;
  private lastLines: string[] = [];

  /** Validates every recovery and idle line against the declared variables up front. */
  constructor(
    private readonly config: AgentConfig,
    schema: JsonSchema,
  ) {
    for (const line of agentRecoveryLines(config)) validateTemplatePaths(line.text, schema);
    this.policy = config.recovery ?? AgentRecovery.parse({});
    this.phrases = new Set(config.recovery?.repeat?.phrases.map(normalizeUtterance) ?? []);
  }

  /** A line the conversation said (not a recovery or idle line): what a repeat replays. */
  remember(turn: number, line: string): void {
    if (turn !== this.lastTurn) {
      this.lastTurn = turn;
      this.lastLines = [];
    }
    this.lastLines.push(line);
  }

  /** The prefix and the last conversational turn, when the caller asked to hear it again. */
  replay(input: string): RecoveryPlan | undefined {
    const repeat = this.config.recovery?.repeat;
    if (!repeat || !this.lastLines.length) return undefined;
    if (!matchesLexicon('repeat', input) && !this.phrases.has(normalizeUtterance(input)))
      return undefined;
    return {
      lines: [
        { field: 'recovery.repeat.prefix', text: repeat.prefix ?? DEFAULT_REPEAT_PREFIX },
        ...this.lastLines.map((text) => ({ field: 'replay', text, rendered: true })),
      ],
    };
  }

  /** An empty reply is recovered before any decision is asked about it. */
  skipsDecision(input: string, llm: boolean): boolean {
    return this.classify({ input, llm })?.reason === 'empty';
  }

  /**
   * `answered`/`end` are what the decision step chose (no `answered`: it would go to the LLM),
   * `verdict` the gate's verdict for the turn.
   */
  route(turn: {
    input: string;
    answered?: string;
    end?: string;
    verdict?: DecisionGateResult;
    llm: boolean;
  }): TurnRoute {
    const miss = this.classify(turn);
    if (!miss) {
      this.misses = 0;
      return { kind: 'answer', say: turn.answered, end: turn.end };
    }
    this.misses += 1;
    if (this.misses <= this.policy.maxAttempts) return { kind: 'recover', plan: this.reask(miss) };
    this.misses = 0;
    const exhausted = this.policy.exhausted;
    // With no LLM bound (a release check already reports it), `llm` ends the call as `end` would.
    if (exhausted.action === 'llm' && turn.llm) return { kind: 'answer' };
    return {
      kind: 'recover',
      plan: {
        lines: [{ field: 'recovery.exhausted.line', text: exhausted.line }],
        end: 'recovery:exhausted',
      },
    };
  }

  private classify(turn: {
    input: string;
    answered?: string;
    verdict?: DecisionGateResult;
    llm: boolean;
  }): RecoveryMiss | undefined {
    const authored = this.config.recovery !== undefined;
    if (!turn.input.trim() && (authored || !turn.llm)) return { reason: 'empty' };
    const verdict = turn.verdict;
    if (verdict?.kind === 'unavailable')
      return authored || this.config.decisionUnavailable || !turn.llm
        ? { reason: 'unavailable' }
        : undefined;
    if (
      authored &&
      verdict?.kind === 'decided' &&
      verdict.action.clarify &&
      turn.answered === this.config.clarification
    ) {
      const key = verdict.resolutions.find((item) => !item.used && item.fallback === 'clarify');
      return { reason: 'clarify', ...(key ? { key: key.questionId } : {}) };
    }
    if (turn.answered === undefined && !turn.llm) return { reason: 'no-llm' };
    return undefined;
  }

  private reask(miss: RecoveryMiss): RecoveryPlan {
    const unavailable = miss.reason === 'unavailable' ? this.config.decisionUnavailable : undefined;
    if (unavailable?.line !== undefined)
      return {
        lines: [{ field: 'decisionUnavailable.line', text: unavailable.line }],
        ...(unavailable.action === 'end' ? { end: 'decision:unavailable' } : {}),
      };
    const reprompt = miss.key === undefined ? undefined : this.policy.reprompts[miss.key];
    return {
      lines: [
        reprompt === undefined
          ? { field: 'recovery.didntCatch', text: this.policy.didntCatch }
          : { field: `recovery.reprompts.${miss.key}`, text: reprompt },
      ],
    };
  }
}

/**
 * Render authored lines for this call. A line the call's data cannot fill (a missing variable, a
 * malformed date) is skipped and reported by field only, never with the value.
 */
export function renderLines(
  lines: readonly AuthoredLine[],
  render: (text: string) => string,
  skipped: (field: string) => void,
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.rendered) {
      out.push(line.text);
      continue;
    }
    try {
      out.push(render(line.text));
    } catch (error) {
      // swallow-ok: reported through `skipped`; the call carries on without the line.
      if (!(error instanceof AnnouncementValidationError)) throw error;
      skipped(line.field);
    }
  }
  return out;
}
