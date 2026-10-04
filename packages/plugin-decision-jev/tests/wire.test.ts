import { DecisionResponse } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import {
  JevProtocolError,
  calibrationVersionOf,
  toDecisionResponse,
  toJevBody,
} from '../src/wire.ts';
import { CHOICE_BODY, NOUL_BODY, SCORE_BODY } from '../src/testing.ts';
import { LABEL, choiceRequest, noulRequest, scoreRequest } from './requests.ts';

describe('toJevBody', () => {
  it('injects the bound model and sends nothing else', () => {
    const body = toJevBody(choiceRequest, 'jev-latest');
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(body.model).toBe('jev-latest');
    expect(body.questions).toEqual(choiceRequest.questions);
    expect(body.state).toBe(choiceRequest.state);
  });

  it('carries every criterion key AND its description verbatim', () => {
    const body = toJevBody(choiceRequest, 'jev-latest');
    const criteria = (body.questions.intent as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria)).toEqual(['pay_now', 'promise_to_pay', 'dispute']);
    expect(criteria.pay_now).toBe('The caller will pay the full amount immediately.');
  });
});

describe('toDecisionResponse', () => {
  it('a verbatim vendor body cannot parse as DecisionResponse, and the mapped one can', () => {
    // This pair is the proof that the adapter is mandatory rather than cosmetic: `usage` and the
    // missing `calibrationVersion` both make the raw body fail the strict contract schema.
    expect(DecisionResponse.safeParse(CHOICE_BODY).success).toBe(false);
    const mapped = toDecisionResponse(choiceRequest, CHOICE_BODY, LABEL);
    expect(DecisionResponse.safeParse(mapped).success).toBe(true);
  });

  it('maps model to modelId and strips usage', () => {
    const mapped = toDecisionResponse(choiceRequest, CHOICE_BODY, LABEL);
    expect(mapped.modelId).toBe('jev-2026-07-01');
    expect(Object.keys(mapped).sort()).toEqual(['answers', 'modelId']);
    expect('usage' in mapped).toBe(false);
  });

  it('stamps calibrationVersion as resolvedModelId/label on every answer', () => {
    const mapped = toDecisionResponse(choiceRequest, CHOICE_BODY, LABEL);
    expect(mapped.answers.intent!.calibrationVersion).toBe(`jev-2026-07-01/${LABEL}`);
    expect(calibrationVersionOf('jev-2026-07-01', LABEL)).toBe(`jev-2026-07-01/${LABEL}`);
  });

  it('derives calibrationVersion from the model that ANSWERED, not the alias requested', () => {
    const aliased = { ...CHOICE_BODY, model: 'jev-2026-11-02' };
    const mapped = toDecisionResponse(choiceRequest, aliased, LABEL);
    expect(mapped.answers.intent!.calibrationVersion).toBe(`jev-2026-11-02/${LABEL}`);
  });

  it('passes awkward probabilities and confidence through byte-equal', () => {
    const mapped = toDecisionResponse(choiceRequest, CHOICE_BODY, LABEL);
    const answer = mapped.answers.intent!;
    expect(answer.confidence).toBe(0.9);
    expect(answer.probabilities).toEqual({ pay_now: 0.8, promise_to_pay: 0.1499, dispute: 0.0501 });
  });

  it('drops `legend` from a score answer, which the strict contract has no field for', () => {
    const mapped = toDecisionResponse(scoreRequest, SCORE_BODY, LABEL);
    const answer = mapped.answers.urgency!;
    expect('legend' in answer).toBe(false);
    expect(answer.type === 'score' && answer.score).toBe(1.7);
    expect(answer.probabilities).toEqual({ '0': 0.1, '1': 0.1, '2': 0.8 });
  });

  it('derives a noul probability vector losslessly from the single documented number', () => {
    const mapped = toDecisionResponse(noulRequest, NOUL_BODY, LABEL);
    const answer = mapped.answers.reachable!;
    expect(answer.type === 'noul' && answer.noul).toBe(0.72);
    expect(answer.probabilities).toEqual({ yes: 0.72, no: 1 - 0.72 });
  });

  it('passes a vendor-supplied noul probability vector through instead of overwriting it', () => {
    const supplied = {
      ...NOUL_BODY,
      answers: {
        reachable: {
          type: 'noul',
          noul: 0.72,
          confidence: 0.64,
          probabilities: { yes: 0.72, no: 0.28 },
        },
      },
    };
    const mapped = toDecisionResponse(noulRequest, supplied, LABEL);
    expect(mapped.answers.reachable!.probabilities).toEqual({ yes: 0.72, no: 0.28 });
  });

  it('refuses a noul answer with NO confidence rather than deriving one', () => {
    const body = { ...NOUL_BODY, answers: { reachable: { type: 'noul', noul: 0.72 } } };
    expect(() => toDecisionResponse(noulRequest, body, LABEL)).toThrow(JevProtocolError);
    expect(() => toDecisionResponse(noulRequest, body, LABEL)).toThrow(/carries no confidence/);
  });

  it('refuses a body with NO model, NO answers and a non-object answer', () => {
    const noModel: Record<string, unknown> = { ...CHOICE_BODY };
    delete noModel.model;
    expect(() => toDecisionResponse(choiceRequest, noModel, LABEL)).toThrow(
      /model must be a non-empty/,
    );
    expect(() => toDecisionResponse(choiceRequest, { model: 'm' }, LABEL)).toThrow(
      /answers must be an object/,
    );
    expect(() =>
      toDecisionResponse(choiceRequest, { model: 'm', answers: { intent: 7 } }, LABEL),
    ).toThrow(/answers.intent must be an object/);
  });

  it('refuses an answer whose type the document does not define', () => {
    const body = { ...CHOICE_BODY, answers: { intent: { type: 'ranking', choice: 'pay_now' } } };
    expect(() => toDecisionResponse(choiceRequest, body, LABEL)).toThrow(/unknown type "ranking"/);
  });
});
