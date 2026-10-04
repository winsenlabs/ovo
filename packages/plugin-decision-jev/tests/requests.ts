// Shared request fixtures. Not a test file, so the §13 kind table applies: contracts only.
import type { DecisionRequest } from '@winsendotai/ovo-contracts';

export const LABEL = 'collections-en-2026-09';

export const choiceRequest: DecisionRequest = {
  state: 'The caller says they will pay the full amount today.',
  questions: {
    intent: {
      type: 'choice',
      instructions: 'What does the caller intend?',
      criteria: {
        pay_now: 'The caller will pay the full amount immediately.',
        promise_to_pay: 'The caller commits to a later date.',
        dispute: 'The caller disputes the amount.',
      },
    },
  },
};

export const noulRequest: DecisionRequest = {
  state: 'The caller answered on the second ring and is speaking clearly.',
  questions: {
    reachable: {
      type: 'noul',
      instructions: 'Is this caller reachable right now?',
      criteria: { yes: 'The caller is reachable.', no: 'The caller is not reachable.' },
    },
  },
};

export const scoreRequest: DecisionRequest = {
  state: 'The caller says the service has been down since yesterday morning.',
  questions: {
    urgency: {
      type: 'score',
      instructions: 'How urgent is this?',
      criteria: ['Can wait', 'Needs attention this week', 'Needs attention today'],
    },
  },
};

/** Two questions over one state — the property that makes a decision slot cost one round trip. */
export const twoQuestionRequest: DecisionRequest = {
  state: 'The caller says they will pay the full amount today.',
  questions: {
    intent: choiceRequest.questions.intent!,
    urgency: scoreRequest.questions.urgency!,
  },
};
