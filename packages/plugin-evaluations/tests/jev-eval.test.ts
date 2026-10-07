import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as contracts from '@winsendotai/ovo-contracts';
import type { DecisionPort, DecisionRequest, DecisionResponse } from '@winsendotai/ovo-contracts';
import { CREDITMANTRI_JEV_EVAL } from '../src/corpus/jev-eval-creditmantri.ts';
import { flowListen, matchFlowPhrase } from '../src/jev-eval-flow.ts';
import {
  jevEvalRequest,
  runJevEval,
  scoreJevCase,
  validateJevEvalSet,
  type JevEvalCase,
  type JevEvalSet,
} from '../src/jev-eval.ts';
import {
  recordJevEval,
  replayDecision,
  synthesizeJevEvalRecording,
  type JevEvalRecording,
} from '../src/jev-eval-recording.ts';
import { formatJevEvalReport, summarizeJevEval } from '../src/jev-eval-report.ts';

const set = CREDITMANTRI_JEV_EVAL;
const recording = JSON.parse(
  readFileSync(
    new URL('../src/corpus/jev-eval-creditmantri.recording.json', import.meta.url),
    'utf8',
  ),
) as JevEvalRecording;
const caseOf = (id: string) => set.cases.find((evalCase) => evalCase.id === id)!;

/** Answers every intent question with `choice` at `confidence`, and every slot with `slot`. */
function answering(
  choice: (request: DecisionRequest) => string,
  confidence = 0.9,
  slot?: string,
  slotConfidence = confidence,
) {
  const requests: DecisionRequest[] = [];
  const answer = (criteria: string[], chosen: string, p: number) => ({
    type: 'choice' as const,
    choice: chosen,
    confidence: p,
    calibrationVersion: 'test',
    probabilities: Object.fromEntries(
      criteria.map((key) => [key, key === chosen ? 0.6 : 0.4 / (criteria.length - 1)]),
    ),
  });
  const port: DecisionPort = {
    async decide(request) {
      requests.push(request);
      const answers: DecisionResponse['answers'] = {};
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type !== 'choice') throw new Error('choice only');
        const keys = Object.keys(question.criteria);
        answers[id] =
          id === 'intent'
            ? answer(keys, choice(request), confidence)
            : answer(keys, slot ?? keys[0]!, slotConfidence);
      }
      return { modelId: 'fixture-jev', answers };
    },
  };
  return { port, requests };
}

describe('CreditMantri Jev eval corpus', () => {
  it('labels every listen set in English, Indian English and Hinglish, with the hard cases', () => {
    expect(validateJevEvalSet(set).cases.length).toBeGreaterThanOrEqual(110);
    for (const listen of set.flow.listens) {
      const cases = set.cases.filter((evalCase) => evalCase.listen === listen.id);
      expect(cases.length, listen.id).toBeGreaterThanOrEqual(6);
      expect(new Set(cases.map((evalCase) => evalCase.language)), listen.id).toContain('hinglish');
    }
    const tags = new Set(set.cases.flatMap((evalCase) => evalCase.tags));
    for (const tag of ['short', 'noisy', 'backchannel', 'qualified', 'slot'])
      expect(tags).toContain(tag);
    const languages = set.cases.map((evalCase) => evalCase.language);
    for (const language of ['en', 'en-IN', 'hinglish'] as const)
      expect(languages.filter((value) => value === language).length).toBeGreaterThanOrEqual(15);
    // Every intent of every listen set is labelled at least once.
    for (const listen of set.flow.listens)
      for (const intent of listen.intents)
        expect(
          set.cases.some((c) => c.listen === listen.id && c.expected === intent.key),
          `${listen.id}.${intent.key}`,
        ).toBe(true);
  });

  it('refuses labels it could not score', () => {
    const broken = (change: Partial<JevEvalCase>) => () =>
      validateJevEvalSet({ ...set, cases: [{ ...set.cases[0]!, ...change }] });
    expect(broken({ expected: 'pay_now' })).toThrow('pay_now is not an intent of identity');
    expect(broken({ listen: 'nowhere' })).toThrow('unknown listen set nowhere');
    expect(
      broken({ listen: 'payment', expected: 'promise_to_pay', slots: { ptp_when: 'soon' } }),
    ).toThrow('ptp_when=soon is not a slot option of payment');
    expect(() =>
      validateJevEvalSet({ ...set, cases: [set.cases[1]!, { ...set.cases[1]!, id: 'x' }] }),
    ).toThrow('Case x: the same reply in the same state twice');
  });
});

describe('the decision state a case is asked in', () => {
  it('is the state of a call that has just reached the node, as the runtime builds it', () => {
    const state = jevEvalRequest(set, caseOf('payment-04')).state as Record<string, unknown>;
    const disclose = [
      'Thank you. Please note that this call is recorded for quality purposes.',
      "I'm calling about your two-wheeler loan ending eight two one three. Your EMI of four thousand eight hundred and fifty rupees, due on the 25th of September, could not be collected because the auto-debit from your bank account bounced due to insufficient balance.",
      'A bounce charge of five hundred and ninety rupees has been added, and the account is now 12 days overdue.',
      'When would you be able to make this payment?',
    ];
    expect(state).toEqual({
      caller_reply: "I'll pay tomorrow.",
      agent_last_said: disclose.join(' '),
      // The last six spoken turns: the greeting's end, the caller's reply, the node's lines.
      recent_turns: [
        'agent: Am I speaking with Rahul Sharma?',
        'caller: yes speaking',
        ...disclose.map((line) => `agent: ${line}`),
      ],
      // `AgentVariables.today()` for en-IN in Asia/Kolkata, not an ISO date.
      today: 'Wednesday, 7 October 2026',
    });
  });

  it('refuses a case no golden conversation reaches', () => {
    expect(() => validateJevEvalSet({ ...set, paths: {} })).toThrow(
      'Case identity-01: no golden conversation reaches greet',
    );
    expect(() =>
      validateJevEvalSet({ ...set, cases: [{ ...caseOf('payment-04'), node: 'greet' }] }),
    ).toThrow('Case payment-04: no node greet listens with payment');
  });
});

describe('the CI gate (recorded answers, no network)', () => {
  it('passes, and reports the rule tier misroute the labels expose', async () => {
    const report = summarizeJevEval(await runJevEval(set, replayDecision(recording)), set.gate);
    expect(report.byTier.error.total).toBe(0);
    expect(report.gate).toEqual({ passed: true, failures: [] });
    expect(report.confusion.link_check!.other).toEqual({ received: 1, other: 1 });
    const text = formatJevEvalReport(report);
    expect(text).toContain('link_check: other -> received  x1');
    expect(text).toContain('link_check-09 [link_check] "ok" expected other, got received (rule)');
    expect(text).toMatch(/Gate: PASS$/);
  });

  it('keeps the committed synthetic answers in step with the corpus', () => {
    if (recording.provenance !== 'synthetic') return;
    expect(synthesizeJevEvalRecording(set, recording.recordedAt)).toEqual(recording);
  });

  it('fails as stale once the flow changes, instead of scoring old answers', async () => {
    const changed: JevEvalSet = structuredClone(set);
    flowListen(changed.flow, 'callback')!.question = 'When should the agent call back?';
    const report = summarizeJevEval(await runJevEval(changed, replayDecision(recording)), set.gate);
    expect(report.byListen.callback).toEqual({ total: 9, correct: 0, accuracy: 0 });
    expect(report.gate.passed).toBe(false);
    expect(report.gate.failures).toContain('9 case(s) got no decision; re-record the answers');
    expect(report.misroutes.find((outcome) => outcome.tier === 'error')!.error).toMatch(
      /No recorded decision for request sha256:/,
    );
  });
});

describe('scoring', () => {
  it('routes the instant tier first and asks the model only what the phrases miss', async () => {
    const { port, requests } = answering(() => 'confirmed');
    expect(await scoreJevCase(set, caseOf('identity-01'), port)).toMatchObject({
      tier: 'rule',
      predicted: 'confirmed',
      correct: true,
    });
    expect(requests).toHaveLength(0);
    await scoreJevCase(set, caseOf('identity-02'), port);
    expect(requests).toHaveLength(1);
    const state = requests[0]!.state as Record<string, unknown>;
    expect(state.agent_last_said).toBe(
      "Hello, I'm calling from CreditMantri. My name is Ananya. Am I speaking with Rahul Sharma?",
    );
    expect(state.caller_reply).toBe('Yes, this is Rahul.');
    expect(Object.keys(requests[0]!.questions.intent!.criteria as object)).toEqual([
      'confirmed',
      'wrong_person',
      'third_party',
      'busy',
      'asks_purpose',
      'repeat',
      'hold',
      'human_agent',
      'stop_calling',
      'abusive',
      'other',
    ]);
  });

  it('turns a choice below the flow threshold into other', async () => {
    const { port } = answering(() => 'confirmed', 0.5);
    expect(await scoreJevCase(set, caseOf('identity-02'), port)).toMatchObject({
      tier: 'decision',
      predicted: 'other',
      modelChoice: 'confirmed',
      confidence: 0.5,
      correct: false,
    });
    expect(await scoreJevCase(set, caseOf('identity-31'), port)).toMatchObject({
      expected: 'other',
      predicted: 'other',
      correct: true,
    });
  });

  it('scores a slot by where it takes the call', async () => {
    const tomorrow = caseOf('payment-04');
    expect(tomorrow.slots).toEqual({ ptp_when: 'tomorrow' });
    const right = await scoreJevCase(
      set,
      tomorrow,
      answering(() => 'promise_to_pay', 0.9, 'tomorrow').port,
    );
    expect(right).toMatchObject({ correct: true, slotCorrect: true });
    const wrong = await scoreJevCase(
      set,
      tomorrow,
      answering(() => 'promise_to_pay', 0.9, 'later').port,
    );
    expect(wrong).toMatchObject({ correct: true, slotCorrect: false });
    // A slot below the threshold is dropped, which routes like the labelled "unspecified".
    const vague = caseOf('payment-13');
    const unsure = await scoreJevCase(
      set,
      vague,
      answering(() => 'promise_to_pay', 0.9, 'today', 0.5).port,
    );
    expect(unsure).toMatchObject({ correct: true, slotCorrect: true });
    const report = summarizeJevEval([right, wrong, unsure], set.gate);
    expect(report.slots).toEqual({ total: 3, correct: 2, accuracy: 2 / 3 });
    expect(formatJevEvalReport(report)).toContain('expected promise_to_pay, got promise_to_pay');
  });

  it('records an unavailable or incoherent decision as an error that fails the gate', async () => {
    const down: DecisionPort = { decide: async () => Promise.reject(new Error('timed out')) };
    expect(await scoreJevCase(set, caseOf('identity-02'), down)).toMatchObject({
      tier: 'error',
      predicted: 'unavailable',
      error: 'timed out',
    });
    const incoherent: DecisionPort = {
      decide: async () => ({
        modelId: 'x',
        answers: {
          intent: {
            type: 'noul',
            noul: 1,
            confidence: 1,
            calibrationVersion: 'x',
            probabilities: { yes: 1, no: 0 },
          },
        },
      }),
    };
    const outcome = await scoreJevCase(set, caseOf('identity-02'), incoherent);
    expect(outcome.tier).toBe('error');
    expect(summarizeJevEval([outcome], set.gate).gate.failures).toEqual([
      'accuracy 0.0% < 90.0%',
      'identity 0.0% < 80.0%',
      '1 case(s) got no decision; re-record the answers',
    ]);
  });
});

describe('recording', () => {
  it('asks the live port once per decided reply and replays its answers exactly', async () => {
    const live = answering((request) => {
      const reply = String((request.state as Record<string, unknown>).caller_reply);
      return reply.includes('?')
        ? 'other'
        : Object.keys(request.questions.intent!.criteria as object)[0]!;
    });
    const recorded = await recordJevEval(set, live.port, { note: 'test', recordedAt: 'now' });
    // 18 replies are whole phrases; a lone "Sorry?" or "kya?" no longer is (P6).
    const decided = set.cases.length - 18;
    expect(live.requests).toHaveLength(decided);
    expect(Object.keys(recorded.answers)).toHaveLength(decided);
    expect(recorded).toMatchObject({ provenance: 'live', modelId: 'fixture-jev' });
    const direct = await runJevEval(set, live.port);
    expect(await runJevEval(set, replayDecision(recorded))).toEqual(direct);
  });
});

/**
 * The eval must score the request production sends. Until the flow contract lands (wave3/flow),
 * `jev-eval-flow.ts` stands in for it; once contracts export the flow compiler this block runs and
 * pins the stand-in to it: same checks, same phrase tier, same request for every labelled reply.
 */
const runtime = contracts as unknown as {
  compileFlow?: (flow: unknown) => unknown;
  inspectFlow?: (flow: unknown) => { severity: string }[];
  flowDecisionRequest?: (compiled: unknown, listen: string, state: unknown) => unknown;
  matchFlowPhrase?: (compiled: unknown, listen: string, reply: string) => string | undefined;
};
describe.skipIf(!runtime.compileFlow)('the stand-in agrees with the flow contract', () => {
  it('asks the runtime request and resolves the runtime phrases for every labelled reply', () => {
    expect(runtime.inspectFlow!(set.flow).filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
    const compiled = runtime.compileFlow!(set.flow);
    for (const evalCase of set.cases) {
      const ours = jevEvalRequest(set, evalCase);
      expect(runtime.flowDecisionRequest!(compiled, evalCase.listen, ours.state)).toEqual(ours);
      expect(runtime.matchFlowPhrase!(compiled, evalCase.listen, evalCase.text)).toEqual(
        matchFlowPhrase(set.flow, evalCase.listen, evalCase.text),
      );
    }
  });
});
