import { describe, expect, it } from 'vitest';
import {
  FixtureDecision,
  checkDecision,
  fixtureDecisionTemplate,
  type DecisionFactory,
  type KitFailure,
} from '../src/index.ts';

const messages = (failures: KitFailure[]) => failures.map((failure) => failure.message).join('\n');

type Answers = Record<string, Record<string, unknown>>;

/**
 * A plugin that is faithful on the wire and corrupts the answer on the way out. Each fake breaks
 * exactly one invariant, so the message the kit produces names that invariant and nothing else.
 */
const broken =
  (mutate: (answers: Answers) => void): DecisionFactory =>
  ({ net, usage, model }) => {
    const real = new FixtureDecision(net, { usage, model });
    return {
      async decide(request, options) {
        const response = await real.decide(request, options);
        mutate(response.answers as unknown as Answers);
        return response;
      },
    };
  };

const run = (mutate: (answers: Answers) => void, only: string) =>
  checkDecision(broken(mutate), { template: fixtureDecisionTemplate }, { only: [only] });

const probabilitiesOf = (answer: Record<string, unknown>) =>
  answer.probabilities as Record<string, number>;

describe('decision@1 rejects probability vectors a schema would accept', () => {
  it('flags probabilities that do not sum to 1', async () => {
    const failures = await run((answers) => {
      const probabilities = probabilitiesOf(answers.q_intent);
      for (const key of Object.keys(probabilities)) probabilities[key] *= 1.4;
    }, 'single choice');
    expect(messages(failures)).toMatch(/Decision probabilities are not normalized for q_intent/);
  });

  it('flags probabilities that do not cover the requested criteria keys', async () => {
    const failures = await run((answers) => {
      answers.q_intent.probabilities = { 0: 0.2, 1: 0.2, 2: 0.6 };
    }, 'single choice');
    expect(messages(failures)).toMatch(/Decision probabilities do not cover criteria for q_intent/);
  });

  it('flags a choice that is not the highest-probability option', async () => {
    const failures = await run((answers) => {
      const probabilities = probabilitiesOf(answers.q_intent);
      const lowest = Object.entries(probabilities).sort((a, b) => a[1] - b[1])[0];
      answers.q_intent.choice = lowest?.[0];
    }, 'single choice');
    expect(messages(failures)).toMatch(
      /Decision choice is not the highest-probability option for q_intent/,
    );
  });

  it('flags a noul that disagrees with its own P(yes)', async () => {
    const failures = await run((answers) => {
      answers.q_commit.noul = probabilitiesOf(answers.q_commit).no;
    }, 'three primitives');
    expect(messages(failures)).toMatch(/Decision noul differs from yes probability for q_commit/);
  });

  it('flags a score that is not the probability-weighted sum of its rubric', async () => {
    const failures = await run((answers) => {
      answers.q_willing.score = (answers.q_willing.score as number) * 2 + 1;
    }, 'three primitives');
    expect(messages(failures)).toMatch(
      /Decision score differs from rubric probabilities for q_willing/,
    );
  });
});

describe('decision@1 rejects answers that do not match the questions', () => {
  it('flags an answer to a question that was not asked', async () => {
    const failures = await run((answers) => {
      answers.q_never_asked = { ...answers.q_intent };
    }, 'single choice');
    expect(messages(failures)).toMatch(/Decision answers must match requested questions/);
    expect(messages(failures)).toMatch(/2 answers came back for one question/);
  });

  it('flags a question that was asked and not answered', async () => {
    const failures = await run((answers) => {
      delete answers.q_willing;
    }, 'three primitives');
    expect(messages(failures)).toMatch(/Decision answers must match requested questions/);
  });

  it('flags a different primitive type than the one requested', async () => {
    const failures = await run((answers) => {
      answers.q_intent = {
        type: 'noul',
        noul: 0.7,
        confidence: 0.8,
        calibrationVersion: 'kit-cal-broken',
        probabilities: { yes: 0.7, no: 0.3 },
      };
    }, 'single choice');
    expect(messages(failures)).toMatch(/Decision answer type differs for q_intent/);
  });
});

describe('decision@1 rejects a calibration cohort it cannot identify', () => {
  it('flags an answer with no calibrationVersion at all', async () => {
    const failures = await run((answers) => {
      for (const answer of Object.values(answers)) delete answer.calibrationVersion;
    }, 'calibration cohort');
    expect(messages(failures)).toMatch(
      /answer q_intent carries no calibrationVersion; an unidentifiable calibration cohort makes the confidence number unusable/,
    );
  });

  it('flags a constant calibrationVersion that never changes across models', async () => {
    const failures = await run((answers) => {
      for (const answer of Object.values(answers)) answer.calibrationVersion = 'v-constant';
    }, 'calibration cohort');
    expect(messages(failures)).toMatch(
      /calibrationVersion 'v-constant' is constant across models kit-decision-a and kit-decision-b/,
    );
  });

  it('flags answers in one response that disagree on their cohort', async () => {
    const failures = await run((answers) => {
      answers.q_commit.calibrationVersion = 'v-other';
    }, 'calibration cohort');
    expect(messages(failures)).toMatch(/answers in one response disagree on calibrationVersion \(/);
  });
});

describe('decision@1 rejects a confidence number that is decorative', () => {
  it('flags a constant confidence regardless of how ambiguous the input is', async () => {
    const failures = await run((answers) => {
      for (const answer of Object.values(answers)) answer.confidence = 0.99;
    }, 'confidence moves');
    expect(messages(failures)).toMatch(
      /an unambiguous input returned 0\.99 and a genuinely ambiguous one 0\.99; a plugin whose confidence never moves is not calibrated, it is decorative/,
    );
  });

  it('flags a confidence rounded to two decimals on the way out', async () => {
    const failures = await run((answers) => {
      answers.q_intent.confidence = Math.round((answers.q_intent.confidence as number) * 100) / 100;
    }, 'passed through');
    expect(messages(failures)).toMatch(
      /confidence came back as 0\.5, not the 0\.4999 the provider reported/,
    );
  });

  it('flags a probability floored on the way out', async () => {
    const failures = await run((answers) => {
      const probabilities = probabilitiesOf(answers.q_intent);
      for (const key of Object.keys(probabilities))
        probabilities[key] = Math.max(probabilities[key] ?? 0, 0.01);
    }, 'passed through');
    expect(messages(failures)).toMatch(/came back as 0\.01, not 0\.0001/);
  });
});
