import type { DecisionRequest, NetFixtureScript, NetFixtureStep } from '@winsendotai/ovo-contracts';
import { JEV_DOC_RETRIEVED, JEV_DOC_SOURCE, JEV_HOST, JEV_ENDPOINT } from './wire.ts';

const ID = '@winsendotai/ovo-decision-jev';

/**
 * Every fixture body below is shaped from the published OpenAPI schemas:
 *   source    https://api.typesafe.ai/openapi.json
 *   retrieved 2026-10-04
 *   ChoiceAnswer  required [choice, confidence, probabilities, type]
 *   ScoreAnswer   required [score, confidence, legend, probabilities, type]
 *   NoulAnswer    required [noul, type]  ← UNCONFIRMED whether `confidence` is ever returned; the
 *                 published schema does not list it, so a noul fixture that carries one is marked
 *                 UNCONFIRMED where it appears and the adapter refuses a body without it.
 *   Usage         required [input_tokens, output_tokens]
 * No request id or response id exists anywhere in the document, so none is scripted.
 */
export interface JevStepOptions {
  /** `where` entries the request body must satisfy — criteria keys and their descriptions. */
  where?: Record<string, unknown>;
  status?: number;
  body?: unknown;
  delayMs?: number;
}

export function jevStep(options: JevStepOptions = {}): NetFixtureStep[] {
  const step: NetFixtureStep = {
    expect: 'http',
    method: 'POST',
    url: JEV_ENDPOINT,
    headers: { authorization: /^Bearer .+/, 'content-type': 'application/json' },
    body: 'json',
    ...(options.where ? { where: options.where } : {}),
    reply: {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
      body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {}),
    },
  };
  return options.delayMs === undefined ? [step] : [{ delayMs: options.delayMs }, step];
}

export function jevScript(steps: NetFixtureStep[]): NetFixtureScript {
  return { host: JEV_HOST, source: JEV_DOC_SOURCE, retrieved: JEV_DOC_RETRIEVED, steps };
}

/** A documented three-option choice reply. `model` is the model that answered, per the schema. */
export const CHOICE_BODY = {
  model: 'jev-2026-07-01',
  answers: {
    intent: {
      type: 'choice',
      choice: 'pay_now',
      confidence: 0.9,
      probabilities: { pay_now: 0.8, promise_to_pay: 0.1499, dispute: 0.0501 },
    },
  },
  usage: { input_tokens: 120, output_tokens: 12 },
};

/** UNCONFIRMED: `confidence` on a noul answer is not in the published NoulAnswer schema. */
export const NOUL_BODY = {
  model: 'jev-2026-07-01',
  answers: { reachable: { type: 'noul', noul: 0.72, confidence: 0.64 } },
  usage: { input_tokens: 40, output_tokens: 4 },
};

/** `legend` is required by the published schema and is dropped by the adapter. */
export const SCORE_BODY = {
  model: 'jev-2026-07-01',
  answers: {
    urgency: {
      type: 'score',
      score: 1.7,
      confidence: 0.9,
      legend: { '0': 'Can wait', '1': 'Needs attention this week', '2': 'Needs attention today' },
      probabilities: { '0': 0.1, '1': 0.1, '2': 0.8 },
    },
  },
  usage: { input_tokens: 90, output_tokens: 9 },
};

export const fixtures: Record<string, NetFixtureScript[]> = {
  [ID]: [jevScript(jevStep({ body: CHOICE_BODY }))],
};

/** A one-exchange script for the choice reply above, for any caller that wants the default. */
export const jevTemplate = (): NetFixtureScript[] => fixtures[ID]!;

/**
 * A documented choice reply answering every question of `request`, for flow and golden tests: the
 * picked option gets `confidence` and 0.9 of the probability, the rest share 0.1, so the shared
 * exchange validator accepts it. A question without a pick answers its last option, which for a
 * flow's intent question is the automatic `other`.
 */
export function jevChoiceBody(
  request: DecisionRequest,
  picks: Record<string, string>,
  confidence = 0.9,
): typeof CHOICE_BODY {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== 'choice') throw new Error(`jevChoiceBody answers choices only: ${id}`);
    const keys = Object.keys(question.criteria);
    const pick = picks[id] ?? keys.at(-1)!;
    if (!keys.includes(pick)) throw new Error(`${pick} is not an option of ${id}`);
    const rest = keys.length > 1 ? 0.1 / (keys.length - 1) : 0;
    answers[id] = {
      type: 'choice',
      choice: pick,
      confidence,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === pick ? 0.9 : rest])),
    };
  }
  return { ...CHOICE_BODY, answers } as typeof CHOICE_BODY;
}
