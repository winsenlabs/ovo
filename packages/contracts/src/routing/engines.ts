import { z } from 'zod';
import {
  DtmfDigits,
  RouteContextKey,
  RouteLanguage,
  RouteVariableName,
  RoutingKey,
} from './ids.ts';
import { RoutingHours } from './hours.ts';

const Threshold = z.number().min(0).max(1);
const Description = z.string().trim().min(1).max(2_000);

export const RulesMatcher = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dtmf'), digits: DtmfDigits }).strict(),
  z
    .object({
      kind: z.literal('caller-id'),
      prefixes: z
        .array(z.string().regex(/^\+[1-9][0-9]{0,14}$/))
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({ kind: z.literal('time'), hours: RoutingHours, inside: z.boolean().default(true) })
    .strict(),
  z
    .object({
      kind: z.literal('variable'),
      name: RouteVariableName,
      equals: z.array(z.string().max(200)).min(1).max(50),
    })
    .strict(),
  /** Whole words anywhere in a reply of at most `maxWords` words, after normalisation. */
  z
    .object({
      kind: z.literal('keywords'),
      words: z.array(z.string().trim().min(1).max(60)).min(1).max(50),
      maxWords: z.number().int().min(1).max(30).default(12),
    })
    .strict(),
  /** Exact normalised replies (lowercase, punctuation dropped, spaces collapsed; Indic scripts kept). */
  z
    .object({
      kind: z.literal('phrases'),
      phrases: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
    })
    .strict(),
  /** Most letters of the reply are in a script these languages use (Devanagari → hi/mr, Tamil → ta...). */
  z
    .object({ kind: z.literal('script'), languages: z.array(RouteLanguage).min(1).max(12) })
    .strict(),
]);
export type RulesMatcher = z.infer<typeof RulesMatcher>;
/** Every matcher in `when` must match. Rules are tried in order; the first match wins with confidence 1. */
export const RulesRule = z
  .object({ branch: RoutingKey, when: z.array(RulesMatcher).min(1).max(8) })
  .strict();
export type RulesRule = z.infer<typeof RulesRule>;

export const RulesEngine = z
  .object({ kind: z.literal('rules'), rules: z.array(RulesRule).min(1).max(64) })
  .strict();
export const DecisionEngine = z
  .object({
    kind: z.literal('decision'),
    /** The choice question's instructions; the criteria are the branch descriptions. */
    instructions: Description,
    threshold: Threshold.default(0.7),
    timeoutMs: z.number().int().min(100).max(5_000).default(800),
  })
  .strict();
export const LlmEngine = z
  .object({
    kind: z.literal('llm'),
    instructions: z.string().trim().min(1).max(4_000),
    threshold: Threshold.default(0.6),
    timeoutMs: z.number().int().min(300).max(8_000).default(2_500),
    /** Ask the classifier for the caller's language too (enum of `language.allowed`). */
    detectLanguage: z.boolean().default(false),
    /** Speak the classifier's own clarifying question (≤200 chars) instead of the authored re-ask. Off by default. */
    generatedClarify: z.boolean().default(false),
  })
  .strict();
export const ExternalEngine = z
  .object({
    kind: z.literal('external'),
    /** https, public host; checked again by parseApprovedEndpoint at publish and at call time. */
    endpoint: z.url().max(2_048),
    /** HMAC secret; must be allowed for the router agent. */
    credentialId: z.string().min(1).max(200),
    timeoutMs: z.number().int().min(100).max(5_000).default(1_500),
    threshold: Threshold.default(0.5),
    send: z
      .object({
        /** E.164 from/to; off by default (data minimisation). */
        callerId: z.boolean().default(false),
        turnText: z.boolean().default(true),
        variables: z.array(RouteVariableName).max(20).default([]),
      })
      .strict()
      .default({ callerId: false, turnText: true, variables: [] }),
    /** Context keys the response may set (`slots`). */
    slots: z.array(RouteContextKey).max(8).default([]),
  })
  .strict();
export type RulesEngine = z.infer<typeof RulesEngine>;
export type DecisionEngine = z.infer<typeof DecisionEngine>;
export type LlmEngine = z.infer<typeof LlmEngine>;
export type ExternalEngine = z.infer<typeof ExternalEngine>;
export const RoutingEngine = z.discriminatedUnion('kind', [
  RulesEngine,
  DecisionEngine,
  LlmEngine,
  ExternalEngine,
]);
export type RoutingEngine = z.infer<typeof RoutingEngine>;
export type RoutingEngineKind = RoutingEngine['kind'];
