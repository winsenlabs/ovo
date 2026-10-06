import { z } from 'zod';
import { GuardrailCheck } from './agent-guardrail.ts';

/**
 * What a call decided, written through `EventSink` (AGT-8) and kept per call: every routing verdict
 * with the tier that made it, the flow states it passed through, the disposition the business acts
 * on, the values the caller gave, and every guardrail verdict on LLM text.
 *
 * Payloads are validated on append and bounded in size; a field this version does not know is kept,
 * so a newer emitter (a flow runtime adding a field) never loses data on an older store.
 */
export const SESSION_EVENT_TYPES = [
  'turn.route',
  'flow.state',
  'disposition',
  'variables.captured',
  'guardrail',
  'call.outcome',
] as const;
export const SessionEventType = z.enum(SESSION_EVENT_TYPES);
export type SessionEventType = z.infer<typeof SessionEventType>;

/** Which tier answered a turn: instant rules, the Jev decision model, the LLM, or a call event. */
export const ROUTE_TIERS = ['rule', 'jev', 'llm', 'event', 'none'] as const;
export const RouteTier = z.enum(ROUTE_TIERS);
export type RouteTier = z.infer<typeof RouteTier>;

const Name = z.string().trim().min(1).max(200);
const Turn = z.number().int().nonnegative();
const Confidence = z.number().min(0).max(1);
/** Caller-supplied values; bounded by the sink's payload size limit, not by shape. */
const Values = z.record(z.string().max(200), z.unknown());

export const TurnRoutePayload = z.looseObject({
  turn: Turn,
  tier: RouteTier,
  /** The flow node the turn was in, and the listen set it was matched against. */
  node: Name.optional(),
  listen: Name.optional(),
  intent: Name.optional(),
  confidence: Confidence.optional(),
  top3: z
    .array(z.object({ intent: Name, confidence: Confidence }))
    .max(3)
    .optional(),
  slots: Values.optional(),
  jevMs: z.number().nonnegative().optional(),
  /** Why the turn left the cheaper tier: `jev_other`, `low_confidence`, `timeout`... */
  fallbackReason: z.string().max(200).optional(),
  modelId: z.string().max(200).optional(),
});
export type TurnRoutePayload = z.infer<typeof TurnRoutePayload>;

export const FlowStatePayload = z.looseObject({
  turn: Turn.optional(),
  from: Name.optional(),
  to: Name,
  reason: z.string().max(200).optional(),
});
export type FlowStatePayload = z.infer<typeof FlowStatePayload>;

export const DispositionPayload = z.looseObject({
  disposition: Name,
  turn: Turn.optional(),
  node: Name.optional(),
  source: z.enum([...ROUTE_TIERS, 'system']).default('system'),
  reason: z.string().max(200).optional(),
});
export type DispositionPayload = z.infer<typeof DispositionPayload>;

export const VariablesCapturedPayload = z.looseObject({
  turn: Turn.optional(),
  variables: Values,
});
export type VariablesCapturedPayload = z.infer<typeof VariablesCapturedPayload>;

export const GuardrailFinding = z.object({
  kind: GuardrailCheck,
  /** The offending words only, never the whole reply. */
  text: z.string().max(100),
});
export type GuardrailFinding = z.infer<typeof GuardrailFinding>;

export const GuardrailPayload = z.looseObject({
  turn: Turn,
  action: z.enum(['flagged', 'blocked']),
  findings: z.array(GuardrailFinding).min(1).max(20),
  /** Time the check took on this sentence, in microseconds. */
  checkUs: z.number().nonnegative(),
});
export type GuardrailPayload = z.infer<typeof GuardrailPayload>;

export const CallOutcomePayload = z.looseObject({
  /** `outcomeFor(reason)`: completed, voicemail, failed... */
  outcome: Name,
  reason: z.string().max(500),
  finalNode: Name.optional(),
});
export type CallOutcomePayload = z.infer<typeof CallOutcomePayload>;

export const SESSION_EVENT_PAYLOADS = {
  'turn.route': TurnRoutePayload,
  'flow.state': FlowStatePayload,
  disposition: DispositionPayload,
  'variables.captured': VariablesCapturedPayload,
  guardrail: GuardrailPayload,
  'call.outcome': CallOutcomePayload,
} as const satisfies Record<SessionEventType, z.ZodType>;

export type SessionEventPayload<T extends SessionEventType> = z.infer<
  (typeof SESSION_EVENT_PAYLOADS)[T]
>;

export type SessionEvent = {
  [T in SessionEventType]: { type: T; payload: SessionEventPayload<T> };
}[SessionEventType];

/** Serialized payloads above this are refused: an event is evidence, not a transcript dump. */
export const SESSION_EVENT_MAX_BYTES = 8_192;

/** Validates one event for storage. Throws on an unknown type, a malformed or an oversized payload. */
export function readSessionEvent(type: string, payload: unknown): SessionEvent {
  const known = SessionEventType.parse(type);
  const parsed = SESSION_EVENT_PAYLOADS[known].parse(payload) as Record<string, unknown>;
  const bytes = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
  if (bytes > SESSION_EVENT_MAX_BYTES)
    throw new RangeError(
      `${known} payload is ${bytes} bytes; the limit is ${SESSION_EVENT_MAX_BYTES}`,
    );
  return { type: known, payload: parsed } as SessionEvent;
}

/**
 * The per-call summary kept beside the events, and what the call list shows. `statePath` is capped
 * at `CALL_OUTCOME_MAX_PATH` entries; the events keep every transition.
 */
export interface CallOutcomeSummary {
  callId: string;
  /** From `call.outcome`; null while the call is running or if it was never recorded. */
  outcome: string | null;
  endReason: string | null;
  /** The last disposition recorded, which is the one the business acts on. */
  disposition: string | null;
  dispositionSource: string | null;
  finalNode: string | null;
  statePath: string[];
  variables: Record<string, unknown>;
  /** Routed turns per tier. */
  tiers: Partial<Record<RouteTier, number>>;
  guardrail: { flagged: number; blocked: number };
  events: number;
  updatedAt: string;
}

export const CALL_OUTCOME_MAX_PATH = 200;
