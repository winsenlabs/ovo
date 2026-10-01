import { describe, expect, it } from 'vitest';
import {
  Cap,
  ClipPreparation,
  DecisionQuestion,
  HumanHandoffRequest,
  HumanHandoffTicket,
  HumanPresence,
  IntentScriptGraph,
  TemplatedClip,
  capabilitySpec,
  validateClipPreparation,
  validateDecisionExchange,
} from '../src/index.ts';

const decision = {
  state: 'The customer asked for a refund.',
  questions: {
    intent: {
      type: 'choice',
      instructions: 'Pick the customer intent',
      criteria: {
        refund: 'Customer asks to reverse a payment',
        balance: 'Customer asks for the current balance',
      },
    },
    consent: {
      type: 'noul',
      instructions: 'Did the customer consent?',
      criteria: {
        yes: 'Explicitly agreed',
        no: 'Refused or did not agree',
      },
    },
    urgency: { type: 'score', instructions: 'Rate urgency', criteria: ['low', 'high'] },
  },
} as const;
const answer = {
  modelId: 'decision-model-1',
  answers: {
    intent: {
      type: 'choice',
      choice: 'refund',
      confidence: 0.8,
      calibrationVersion: 'v1',
      probabilities: { refund: 0.8, balance: 0.2 },
    },
    consent: {
      type: 'noul',
      noul: 0.7,
      confidence: 0.7,
      calibrationVersion: 'v1',
      probabilities: { yes: 0.7, no: 0.3 },
    },
    urgency: {
      type: 'score',
      score: 0.4,
      confidence: 0.6,
      calibrationVersion: 'v1',
      probabilities: { '0': 0.6, '1': 0.4 },
    },
  },
} as const;

describe('post-I1 provider-neutral decision contract', () => {
  it('defines session capability and validates all three answer primitives', () => {
    expect(capabilitySpec(Cap.decision).scope).toBe('session');
    expect(validateDecisionExchange(decision, answer).response.answers.urgency).toMatchObject({
      score: 0.4,
    });
  });

  it('rejects absent answers, criteria, calibration, and mismatched probability mass', () => {
    const withoutConsent = structuredClone(answer) as { answers: Record<string, unknown> };
    delete withoutConsent.answers.consent;
    expect(() => validateDecisionExchange(decision, withoutConsent)).toThrow(
      'must match requested questions',
    );
    const missingCriterion = structuredClone(answer) as {
      answers: { intent: { probabilities: Record<string, number> } };
    };
    delete missingCriterion.answers.intent.probabilities.balance;
    expect(() => validateDecisionExchange(decision, missingCriterion)).toThrow(
      'do not cover criteria',
    );
    const noCalibration = structuredClone(answer) as {
      answers: { intent: Record<string, unknown> };
    };
    delete noCalibration.answers.intent.calibrationVersion;
    expect(() => validateDecisionExchange(decision, noCalibration)).toThrow();
    const badMass = structuredClone(answer) as unknown as {
      answers: { consent: { probabilities: { yes: number } } };
    };
    badMass.answers.consent.probabilities.yes = 0.1;
    expect(() => validateDecisionExchange(decision, badMass)).toThrow('not normalized');
    expect(
      DecisionQuestion.safeParse({
        type: 'choice',
        instructions: 'pick',
        criteria: { only: 'one' },
      }).success,
    ).toBe(false);
  });
});

const handoff = {
  workspaceId: 'ws',
  sessionId: 'session',
  idempotencyKey: 'retry-key',
  queueId: 'queue',
  mode: 'OPEN_PICKUP',
  summary: 'Caller asked for a human',
  acceptTimeoutMs: 30_000,
} as const;

describe('human handoff port contract', () => {
  it('accepts an independent built-in queue or external assignment mode', () => {
    expect(capabilitySpec(Cap.humanHandoff).scope).toBe('either');
    expect(HumanHandoffRequest.parse(handoff).mode).toBe('OPEN_PICKUP');
    expect(HumanHandoffRequest.parse({ ...handoff, mode: 'AUTO_ASSIGN' }).mode).toBe('AUTO_ASSIGN');
    expect(
      HumanHandoffTicket.parse({
        id: 'ticket',
        workspaceId: 'ws',
        sessionId: 'session',
        queueId: 'queue',
        status: 'accepted',
        version: 2,
        assignedOperatorId: 'operator',
      }).status,
    ).toBe('accepted');
  });

  it('rejects an accepted ticket with no operator, overcommitted presence, and absent retry key', () => {
    expect(
      HumanHandoffTicket.safeParse({
        id: 'ticket',
        workspaceId: 'ws',
        sessionId: 'session',
        queueId: 'queue',
        status: 'accepted',
        version: 2,
      }).success,
    ).toBe(false);
    expect(
      HumanPresence.safeParse({
        operatorId: 'op',
        status: 'AVAILABLE',
        capacity: 1,
        activeAssignments: 2,
        teamIds: [],
        updatedAt: '2026-10-01T00:00:00Z',
      }).success,
    ).toBe(false);
    const noKey = { ...handoff } as Record<string, unknown>;
    delete noKey.idempotencyKey;
    expect(HumanHandoffRequest.safeParse(noKey).success).toBe(false);
  });
});

const graph = {
  version: 1,
  start: 'ask',
  maxVisits: 10,
  globalIntents: [
    { id: 'human', description: 'Caller wants an operator', minConfidence: 0.8, slots: [] },
  ],
  nodes: [
    {
      id: 'ask',
      prompt: 'What would you like?',
      terminal: false,
      steps: [
        {
          id: 'product',
          kind: 'ASK',
          attribute: 'product',
          prompt: { text: 'Which product?' },
          options: [
            { value: 'loan', label: 'Loan' },
            { value: 'card', label: 'Card' },
          ],
          maxAttempts: 2,
          skipIfKnown: true,
        },
      ],
      intents: [
        { id: 'balance', description: 'Asks for balance', minConfidence: 0.7, slots: ['product'] },
      ],
      routes: [
        { intentId: 'balance', when: { product: 'card' }, to: 'done' },
        { intentId: 'human', when: {}, to: 'done' },
      ],
      fallback: { kind: 'llm', resumeAt: 'ask' },
    },
    { id: 'done', prompt: 'Done', terminal: true, steps: [], intents: [], routes: [] },
  ],
} as const;

describe('OCSO-derived intent graph', () => {
  it('has versioned ASK steps, global intents, slot routes, and a named LLM resume point', () => {
    expect(IntentScriptGraph.parse(graph).nodes[0]?.fallback).toEqual({
      kind: 'llm',
      resumeAt: 'ask',
    });
  });

  it('refuses dangling nodes, unknown intent and slot, and duplicate options', () => {
    const dangling = structuredClone(graph) as unknown as {
      nodes: Array<{ routes: Array<{ to: string }> }>;
    };
    dangling.nodes[0]!.routes[0]!.to = 'missing';
    expect(IntentScriptGraph.safeParse(dangling).success).toBe(false);
    const unknown = structuredClone(graph) as unknown as {
      nodes: Array<{ routes: Array<{ intentId: string; when: Record<string, string> }> }>;
    };
    unknown.nodes[0]!.routes[0]!.intentId = 'unknown';
    expect(IntentScriptGraph.safeParse(unknown).success).toBe(false);
    unknown.nodes[0]!.routes[0]!.intentId = 'balance';
    unknown.nodes[0]!.routes[0]!.when = { unextracted: 'card' };
    expect(IntentScriptGraph.safeParse(unknown).success).toBe(false);
    const duplicate = structuredClone(graph) as unknown as {
      nodes: Array<{ steps: Array<{ options: Array<{ value: string }> }> }>;
    };
    duplicate.nodes[0]!.steps[0]!.options[1]!.value = 'LOAN';
    expect(IntentScriptGraph.safeParse(duplicate).success).toBe(false);
  });
});

const clip = {
  id: 'welcome',
  locale: 'en-IN',
  text: 'Hello {{name}}, your balance is {{balance}}.',
  variables: [
    { name: 'name', maxLength: 30, description: 'Contact name' },
    { name: 'balance', maxLength: 20, description: 'Balance spoken text' },
  ],
} as const;
const preparation = {
  workspaceId: 'ws',
  releaseId: 'release',
  contactId: 'contact',
  clipId: 'welcome',
  values: { name: 'Ada', balance: 'one hundred' },
  deadlineMs: 5_000,
} as const;

describe('templated clip before dialing', () => {
  it('validates a complete per-contact request within the declared limits', () => {
    expect(TemplatedClip.parse(clip).id).toBe('welcome');
    expect(validateClipPreparation(TemplatedClip.parse(clip), preparation).values.name).toBe('Ada');
    expect(ClipPreparation.parse(preparation).deadlineMs).toBe(5_000);
  });

  it('rejects undeclared or missing variables, oversized contact values and malformed placeholders', () => {
    expect(TemplatedClip.safeParse({ ...clip, text: 'Hello {{unknown}}.' }).success).toBe(false);
    expect(TemplatedClip.safeParse({ ...clip, text: 'Hello {{name}.' }).success).toBe(false);
    expect(() =>
      validateClipPreparation(TemplatedClip.parse(clip), {
        ...preparation,
        values: { name: 'Ada' },
      }),
    ).toThrow('every declared variable');
    expect(() =>
      validateClipPreparation(TemplatedClip.parse(clip), {
        ...preparation,
        values: { ...preparation.values, name: 'x'.repeat(31) },
      }),
    ).toThrow('too long');
  });
});
