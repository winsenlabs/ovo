import type {
  AgentConfig,
  AgentGuardrailPolicy,
  EventSink,
  GuardrailCheck,
  GuardrailPayload,
  OperationRecord,
} from '@winsendotai/ovo-contracts';
import { findClaims, textKeys, valueKeys, type GuardrailClaim } from './guardrail-detect.ts';
import { agentTemplates, builtinVariables } from './agent-variables.ts';
import { recordSessionEvent } from './outcome-events.ts';

/** Per-session counters for the guardrail, read by the worker when the call ends. */
export class GuardrailMetrics {
  segments = 0;
  flagged = 0;
  blocked = 0;
  /** Sentences dropped after a block: the rest of a reply that already went wrong. */
  dropped = 0;
  readonly findings: Partial<Record<GuardrailCheck, number>> = {};
  checkUsTotal = 0;
  checkUsMax = 0;

  observe(
    checkUs: number,
    findings: readonly GuardrailClaim[],
    action: 'pass' | 'flagged' | 'blocked',
  ) {
    this.segments += 1;
    this.checkUsTotal += checkUs;
    this.checkUsMax = Math.max(this.checkUsMax, checkUs);
    if (action !== 'pass') this[action] += 1;
    for (const finding of findings)
      this.findings[finding.kind] = (this.findings[finding.kind] ?? 0) + 1;
  }

  snapshot() {
    return {
      segments: this.segments,
      flagged: this.flagged,
      blocked: this.blocked,
      dropped: this.dropped,
      findings: { ...this.findings },
      checkUsTotal: this.checkUsTotal,
      checkUsMax: this.checkUsMax,
    };
  }
}

/** What the agent hands the pre-reply step so the LLM's reply can be checked as it streams. */
export interface ReplyGuardrailInput {
  policy: AgentGuardrailPolicy;
  /** Spoken in place of a blocked reply when the policy names no `safeLine`. */
  fallback: string;
  /**
   * Values the LLM may state beyond the call's variables and the agent's own text: the built-in
   * dates and this turn's tool results. Read at each check, since tools settle during the turn.
   */
  values?: () => readonly unknown[];
  record?: (event: GuardrailPayload) => void;
  metrics?: GuardrailMetrics;
}

/**
 * The guardrail input for one agent turn: the built-in dates and the turn's tool results may be
 * stated too (tools settle during the turn, so `results` is read at each check), and every verdict
 * is recorded on the call's event sink.
 */
export function agentGuardrailInput(
  policy: AgentGuardrailPolicy,
  agent: {
    config: Pick<AgentConfig, 'uncertainty' | 'timezone'>;
    now?: () => Date;
    events?: EventSink;
  },
  results: readonly OperationRecord[],
  metrics: GuardrailMetrics,
): ReplyGuardrailInput {
  const now = agent.now ?? (() => new Date());
  return {
    policy,
    fallback: agent.config.uncertainty,
    values: () => [
      builtinVariables(now(), agent.config.timezone),
      ...results.map((record) => record.result),
    ],
    record: (event) => recordSessionEvent(agent.events, 'guardrail', event),
    metrics,
  };
}

/** Everything an agent authored that the LLM may repeat. Templates count by their literal text. */
export function authoredGuardrailTexts(config: AgentConfig): string[] {
  return [
    ...agentTemplates(config).map((entry) => entry.template),
    config.uncertainty,
    config.clarification,
    config.processing.initial,
    config.processing.progress ?? '',
    config.processing.failure,
    ...config.tools.flatMap((tool) => [tool.processing?.failure ?? '']),
  ].filter(Boolean);
}

const STATIC_KEYS = new Map<string, ReadonlySet<string>>();
const STATIC_KEYS_MAX = 32;

/**
 * The declared keys for the agent's text plus this call's facts. The text is the same on every
 * turn of a call, so it is parsed once and shared; per-turn work is then only the reply itself.
 */
function staticKeys(texts: readonly string[], variables: Readonly<Record<string, unknown>>) {
  const cacheKey = `${texts.join('\u0000')}\u0001${JSON.stringify(variables)}`;
  const cached = STATIC_KEYS.get(cacheKey);
  if (cached) return cached;
  const keys = new Set<string>();
  for (const text of texts) textKeys(text, keys);
  valueKeys(variables, keys);
  if (STATIC_KEYS.size >= STATIC_KEYS_MAX) STATIC_KEYS.delete(STATIC_KEYS.keys().next().value!);
  STATIC_KEYS.set(cacheKey, keys);
  return keys;
}

/**
 * Checks one LLM reply, a sentence at a time, as the stream is segmented: the first sentence is
 * spoken as soon as it is checked, so the check never waits for the rest of the reply. A blocked
 * sentence becomes the safe line and every later sentence of that reply is dropped, because a
 * reply that invented one value is not trusted to finish.
 */
export class ReplyGuardrail {
  private readonly checks: ReadonlySet<GuardrailCheck>;
  private readonly declared: ReadonlySet<string>;
  private dynamic = new Set<string>();
  private dynamicCount = -1;
  private blocked = false;

  constructor(
    private readonly input: ReplyGuardrailInput,
    texts: readonly string[],
    variables: Readonly<Record<string, unknown>>,
    private readonly turn: number,
  ) {
    this.checks = new Set(input.policy.checks);
    this.declared = staticKeys([...texts, ...input.policy.allow], variables);
  }

  /** The text to speak for this sentence, or undefined to drop it. */
  check(segment: string): string | undefined {
    if (this.blocked) {
      if (this.input.metrics) this.input.metrics.dropped += 1;
      return undefined;
    }
    const started = performance.now();
    const findings = findClaims(segment, this.checks).filter(
      (claim) => !claim.keys.some((key) => this.allowed(key)),
    );
    const checkUs = Math.round((performance.now() - started) * 1_000);
    const action = !findings.length
      ? 'pass'
      : this.input.policy.mode === 'block'
        ? 'blocked'
        : 'flagged';
    this.input.metrics?.observe(checkUs, findings, action);
    if (action === 'pass') return segment;
    this.input.record?.({
      turn: this.turn,
      action,
      findings: findings
        .slice(0, 20)
        .map((claim) => ({ kind: claim.kind, text: claim.text.slice(0, 100) })),
      checkUs,
    });
    if (action === 'flagged') return segment;
    this.blocked = true;
    return this.input.policy.safeLine ?? this.input.fallback;
  }

  private allowed(key: string): boolean {
    if (this.declared.has(key)) return true;
    const values = this.input.values?.() ?? [];
    if (values.length !== this.dynamicCount) {
      this.dynamic = new Set();
      valueKeys(values, this.dynamic);
      this.dynamicCount = values.length;
    }
    return this.dynamic.has(key);
  }
}
