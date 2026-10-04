import {
  validateDecisionExchange,
  type DecisionRequest,
  type DecisionResponse,
} from '@winsendotai/ovo-contracts';

/**
 * The TypeSafe System One wire format, pinned from the published OpenAPI document.
 *
 *   source:    https://api.typesafe.ai/openapi.json
 *   retrieved: 2026-10-04
 *
 * Pinned verbatim from that document:
 *   path            POST /v1/systemone
 *   auth            `Authorization: Bearer <key>`
 *   request         {state, model, questions: {<id>: {type, instructions, criteria}}}
 *   model id        request `model` (an alias); response `model` (the model that answered)
 *   response        {model, answers: {<id>: ChoiceAnswer | NoulAnswer | ScoreAnswer}, usage}
 *   usage           {input_tokens (billable), output_tokens (free)} — both required
 *   statuses        200 Successful Response, 422 Validation Error (`detail[]`). No others documented.
 *   ChoiceAnswer    required [choice, confidence, probabilities, type]; probabilities keyed by
 *                   criteria name.
 *   ScoreAnswer     required [score, confidence, legend, probabilities, type]; probabilities keyed
 *                   by rubric level ("0", "1", …); `score` is the probability-weighted average.
 *   NoulAnswer      required [noul, type] ONLY. `noul` is documented as "Probability of a yes
 *                   answer or a true statement, from 0 to 1".
 *
 * UNCONFIRMED (the document states none of these):
 *   - No request id or response id field, and no id header. `requestId` is therefore synthesized.
 *   - 401/403/429/5xx are not documented. They are handled on the HTTP status alone.
 *   - NoulAnswer carries neither `confidence` nor `probabilities`. See `noulAnswer` below for how
 *     that gap is handled; it is NOT papered over with a fabricated confidence.
 *   - The request schema sets no `additionalProperties: false`, so extra fields are tolerated by
 *     the vendor. This adapter still sends only the three documented fields.
 */
export const JEV_DOC_SOURCE = 'https://api.typesafe.ai/openapi.json';
export const JEV_DOC_RETRIEVED = '2026-10-04';
export const JEV_HOST = 'api.typesafe.ai';
export const JEV_PATH = '/v1/systemone';
export const JEV_ENDPOINT = `https://${JEV_HOST}${JEV_PATH}`;

export class JevProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevProtocolError';
  }
}

/** A vendor refusal. `retryable` is true only for 429 and 5xx. */
export class JevRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'JevRequestError';
  }
}

export class JevTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevTimeoutError';
  }
}

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevBody {
  model: string;
  state: DecisionRequest['state'];
  questions: DecisionRequest['questions'];
}

/**
 * `DecisionRequest` is `.strict()` and carries no `model`, so the bound model is injected here.
 * Nothing else is added: a verbatim contract request never crosses the wire unchanged.
 */
export function toJevBody(request: DecisionRequest, model: string): JevBody {
  return { model, state: request.state, questions: request.questions };
}

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new JevProtocolError(`Jev response ${what} must be an object`);
  return value as Record<string, unknown>;
};

const asNumber = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new JevProtocolError(`Jev response ${what} must be a finite number`);
  return value;
};

/** `usage` is required by the published schema; a body without it cannot be metered honestly. */
export function readUsage(body: Record<string, unknown>): JevUsage {
  const usage = asRecord(body.usage, 'usage');
  return {
    input_tokens: asNumber(usage.input_tokens, 'usage.input_tokens'),
    output_tokens: asNumber(usage.output_tokens, 'usage.output_tokens'),
  };
}

function probabilities(raw: unknown, id: string): Record<string, number> {
  const source = asRecord(raw, `answers.${id}.probabilities`);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source))
    out[key] = asNumber(value, `answers.${id}.probabilities.${key}`);
  return out;
}

/**
 * A `noul` answer, from a body that documents only `{type, noul}`.
 *
 * `probabilities` is DERIVED as `{yes: noul, no: 1 - noul}` when the body carries none. That adds
 * no information: the vendor defines `noul` as P(yes) for a binary question, so the two-element
 * vector is a restatement of the one number returned. When the body DOES carry a `probabilities`
 * block it is passed through verbatim, so a vendor vector that disagrees with `noul` is caught by
 * `validateDecisionExchange` rather than overwritten.
 *
 * `confidence` is NOT derived. Nothing in the returned body determines it and the document states
 * no definition for it on this primitive, so a body without `confidence` is refused by name. There
 * is no definitional bridge from `noul` to a confidence the way there is to a probability vector.
 */
function noulAnswer(raw: Record<string, unknown>, id: string): Record<string, unknown> {
  const noul = asNumber(raw.noul, `answers.${id}.noul`);
  if (raw.confidence === undefined)
    throw new JevProtocolError(
      `Jev noul answer ${id} carries no confidence; the contract requires one and this adapter ` +
        `does not derive it (see src/wire.ts)`,
    );
  return {
    type: 'noul',
    noul,
    confidence: asNumber(raw.confidence, `answers.${id}.confidence`),
    probabilities:
      raw.probabilities === undefined
        ? { yes: noul, no: 1 - noul }
        : probabilities(raw.probabilities, id),
  };
}

/** Maps one vendor answer, dropping every field the contract does not name (`legend`). */
function mapAnswer(raw: unknown, id: string, calibrationVersion: string): Record<string, unknown> {
  const answer = asRecord(raw, `answers.${id}`);
  const base = { calibrationVersion };
  if (answer.type === 'noul') return { ...noulAnswer(answer, id), ...base };
  if (answer.type === 'choice' || answer.type === 'score') {
    const value =
      answer.type === 'choice'
        ? { choice: answer.choice }
        : { score: asNumber(answer.score, `answers.${id}.score`) };
    return {
      type: answer.type,
      ...value,
      confidence: asNumber(answer.confidence, `answers.${id}.confidence`),
      probabilities: probabilities(answer.probabilities, id),
      ...base,
    };
  }
  throw new JevProtocolError(`Jev answer ${id} has unknown type ${JSON.stringify(answer.type)}`);
}

/** The model that actually answered, which may differ from the alias the request asked for. */
export function readModelId(body: Record<string, unknown>): string {
  if (typeof body.model !== 'string' || !body.model)
    throw new JevProtocolError('Jev response model must be a non-empty string');
  return body.model;
}

/**
 * `${resolvedModelId}/${label}`. Jev returns no calibration version, and the contract requires one
 * on every answer, so it is composed from the only two facts that identify the cohort: the model
 * that answered and the operator's binding-configured label. See README.md.
 */
export function calibrationVersionOf(resolvedModelId: string, label: string): string {
  return `${resolvedModelId}/${label}`;
}

/**
 * Vendor 200 body → `DecisionResponse`, then `validateDecisionExchange` against the request that
 * produced it. `usage` and `legend` are dropped here: `DecisionResponse` is `.strict()`, so a
 * verbatim vendor body cannot parse and the adapter is therefore mandatory, not cosmetic.
 */
export function toDecisionResponse(
  request: DecisionRequest,
  body: Record<string, unknown>,
  calibrationLabel: string,
): DecisionResponse {
  const modelId = readModelId(body);
  const answers = asRecord(body.answers, 'answers');
  const version = calibrationVersionOf(modelId, calibrationLabel);
  const mapped: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(answers)) mapped[id] = mapAnswer(raw, id, version);
  try {
    return validateDecisionExchange(request, { modelId, answers: mapped }).response;
  } catch (error) {
    // Rethrown under our own name so a caller can tell a broken vendor body from a broken caller
    // request, while keeping the invariant the contract named. Never repaired, never renormalized.
    throw new JevProtocolError(
      `Jev response violates the decision contract: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
