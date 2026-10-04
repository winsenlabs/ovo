import { Cap, type DecisionCapabilities } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  DEFAULT_MAX_QUESTIONS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  resolveBinding,
} from './binding.ts';
import { METER_INPUT_TOKENS, jevDecision } from './decide.ts';
import { JEV_DOC_SOURCE, JEV_ENDPOINT, JEV_HOST, JEV_PATH } from './wire.ts';

export {
  resolveBinding,
  JevBindingError,
  type JevBinding,
  type ResolvedJevBinding,
} from './binding.ts';
export { jevDecision, METER_INPUT_TOKENS, PROVIDER } from './decide.ts';
export {
  JEV_DOC_RETRIEVED,
  JEV_DOC_SOURCE,
  JEV_ENDPOINT,
  JEV_HOST,
  JEV_PATH,
  JevProtocolError,
  JevRequestError,
  JevTimeoutError,
  calibrationVersionOf,
  toDecisionResponse,
  toJevBody,
} from './wire.ts';
export { fixtures, jevScript, jevTemplate } from './testing.ts';

/**
 * Declared from the published document only. `maxCriteria` is the contract's own ceiling for a
 * choice question (255); the document states no vendor limit, so nothing lower is invented.
 * `calibration` identifies the cohort, not a measurement: see README.md — no per-language ECE is
 * claimed here because none has been measured.
 */
export const JEV_CAPABILITIES: DecisionCapabilities = {
  primitives: ['choice', 'noul', 'score'],
  maxCriteria: 255,
  maxQuestionsPerRequest: DEFAULT_MAX_QUESTIONS,
  languages: ['en'],
  calibration: { label: 'binding.calibrationLabel', source: JEV_DOC_SOURCE },
};

/** The F3 session row: `{binding, credentialRef, …}`, exactly as `select-session-graph` yields it. */
const ROW_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    binding: { type: 'object' },
    credentialRef: { type: 'object' },
    workspaceId: { type: 'string' },
    bindingId: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/**
 * `calibrationLabel` is the only required field and has no default — see README.md. There is
 * deliberately NO threshold field: the confidence threshold belongs to the caller, not to a
 * decision provider.
 */
const BINDING_SCHEMA = {
  type: 'object',
  required: ['calibrationLabel'],
  properties: {
    calibrationLabel: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1, default: DEFAULT_MODEL },
    endpoint: { type: 'string', format: 'uri', default: JEV_ENDPOINT },
    timeoutMs: {
      type: 'integer',
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
      default: DEFAULT_TIMEOUT_MS,
    },
    maxQuestionsPerRequest: { type: 'integer', minimum: 1, default: DEFAULT_MAX_QUESTIONS },
  },
  additionalProperties: false,
} as const;

export const jevDecisionPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-decision-jev',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'decision',
    provider: 'typesafe',
    provides: [Cap.decision],
    requires: [],
    optional: [Cap.usage],
    configSchema: ROW_CONFIG_SCHEMA,
    bindingSchema: BINDING_SCHEMA,
    secretFields: [''],
    capabilities: JEV_CAPABILITIES,
    // A decision costs money, so a release with no price card for this key is refused at admission.
    // Only the billable unit is declared: the document calls `output_tokens` free, and one meter per
    // decision is what `decision@1` requires. See README.md.
    meters: [
      {
        key: METER_INPUT_TOKENS,
        unit: 'input_tokens',
        label: 'TypeSafe decision input tokens',
        role: 'decision',
      },
    ],
    runtime: { egressHosts: [JEV_HOST], modelLicences: [] },
    conformance: ['decision@1'],
    ui: {
      slot: 'decision',
      label: 'TypeSafe Jev Decisions',
      description: 'Choice, noul and score decisions over TypeSafe System One.',
      vendor: 'TypeSafe',
      docsUrl: JEV_DOC_SOURCE,
    },
  },
  async (ctx, row) => {
    // `secretFields: ['']` puts the key at the row root, so the pointer is the root pointer.
    // Refused here, before the key is read, when the binding names no calibration cohort.
    const binding = resolveBinding(row.binding);
    ctx.provide(
      Cap.decision,
      jevDecision(ctx.net, await ctx.secret(''), binding, ctx.maybe(Cap.usage)),
    );
  },
);

export const plugins = [jevDecisionPlugin];

/** Re-exported so a reader of the manifest can find the pinned path without opening wire.ts. */
export const JEV_REQUEST_PATH = JEV_PATH;
