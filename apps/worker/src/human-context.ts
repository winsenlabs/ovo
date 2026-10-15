import type { CallMemory, SegmentHistoryEntry } from './call-memory.ts';
import type { QueueContextPolicy, TicketContext } from './human-contract.ts';

const SUMMARY_CHARS = 1_000;
const REASON_CHARS = 200;
const LINE_CHARS = 500;
const TRANSCRIPT_CHARS = 6_000;
const VARIABLE_CHARS = 500;
const MAX_VARIABLES = 20;

/** What the transferring side knows that the host cannot see: free text, untrusted. */
export interface ContextMeta {
  summary?: string;
  reason?: string;
}

export interface ContextInput {
  policy: QueueContextPolicy;
  callId: string;
  /** The caller and the dialled number, as the job carries them. */
  numbers: { from?: string; to?: string };
  memory: Pick<CallMemory, 'route' | 'recent'>;
  meta?: ContextMeta;
  /** The spoken name of what was asked for (a catalogue label), else the queue's name. */
  askedFor: string;
  from: Pick<SegmentHistoryEntry, 'role' | 'agentId' | 'releaseId'>;
  /**
   * The captured values the transferring agent's variables schema declares (`declared`), or the
   * call's values to pick the allow-list from.
   */
  values: Readonly<Record<string, unknown>>;
  returnTargets: readonly { key: string; label: string }[];
}

const scalar = (value: unknown): value is string | number | boolean =>
  ['string', 'number', 'boolean'].includes(typeof value);

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    // swallow-ok: an unknown code is shown as it is.
    return code;
  }
}

/** A masked number for operator lists: the country prefix and the last four digits remain. */
export function maskNumber(number: string | undefined): string | undefined {
  if (!number) return undefined;
  const digits = number.length;
  if (digits <= 7) return '*'.repeat(digits);
  return `${number.slice(0, 3)}${'*'.repeat(digits - 7)}${number.slice(-4)}`;
}

/**
 * The ticket context (human queue design 7.3): everything a queue may know about the call and
 * nothing its policy leaves off. The brief is deterministic (route values, never model text); the
 * summary and reason are the transferring agent's own words, kept as untrusted text; the
 * transcript is the last `transcriptTurns` lines, capped; variables are declared (the transferring
 * agent's schema) or an explicit allow-list. It is stored in the ticket row only: never evented,
 * logged or put in a prompt.
 */
export function buildTicketContext(input: ContextInput): TicketContext {
  const { policy, memory, meta } = input;
  const route = memory.route;
  const language = policy.language ? route?.language : undefined;
  const intent = policy.intent ? route?.context.intent : undefined;
  const briefParts = [
    language ? `Language: ${languageName(language)}.` : undefined,
    intent ? `Intent: ${intent}.` : undefined,
    `Asked for: ${input.askedFor}.`,
  ];
  const lines = policy.transcriptTurns ? memory.recent().slice(-policy.transcriptTurns) : [];
  let budget = TRANSCRIPT_CHARS;
  const transcript = [...lines]
    .reverse()
    .map((line) => ({ role: line.role, text: line.text.slice(0, LINE_CHARS) }))
    .filter((line) => (budget -= line.text.length) >= 0)
    .reverse();
  const allowed = policy.variables === 'declared' ? undefined : new Set(policy.variables);
  const variables = Object.fromEntries(
    Object.entries(input.values)
      .filter(([name, value]) => scalar(value) && (!allowed || allowed.has(name)))
      .slice(0, MAX_VARIABLES)
      .map(([name, value]) => [
        name.slice(0, 64),
        typeof value === 'string' ? value.slice(0, VARIABLE_CHARS) : (value as number | boolean),
      ]),
  );
  const summary =
    policy.summary && meta?.summary ? meta.summary.slice(0, SUMMARY_CHARS) : undefined;
  const reason = policy.summary && meta?.reason ? meta.reason.slice(0, REASON_CHARS) : undefined;
  return {
    callId: input.callId,
    brief: briefParts.filter(Boolean).join(' ').slice(0, 400),
    ...(summary ? { summary } : {}),
    ...(reason ? { reason } : {}),
    ...(language ? { language } : {}),
    ...(intent ? { intent: intent.slice(0, 80) } : {}),
    routePath: (route?.path ?? []).slice(-32),
    caller: {
      ...(policy.callerId && input.numbers.from ? { number: input.numbers.from } : {}),
      ...(policy.calledNumber && input.numbers.to ? { calledNumber: input.numbers.to } : {}),
    },
    transcript,
    variables,
    ...(input.from.role === 'agent'
      ? { fromAgent: { agentId: input.from.agentId, releaseId: input.from.releaseId } }
      : {}),
    returnTargets: input.returnTargets.map(({ key, label }) => ({
      key,
      label: label.slice(0, 120),
    })),
  };
}
