import { describe, expect, it } from 'vitest';
import type { DecisionQuestion, DecisionResponse, UsageMeter } from '@winsendotai/ovo-contracts';
import {
  FixtureDecision,
  checkDecision,
  fixtureDecisionTemplate,
  type DecisionFactory,
  type KitFailure,
} from '../src/index.ts';

const messages = (failures: KitFailure[]) => failures.map((failure) => failure.message).join('\n');

const kit = (factory: DecisionFactory, only: string, timeoutMs?: number) =>
  checkDecision(factory, { template: fixtureDecisionTemplate }, { only: [only], timeoutMs });

const faithful: DecisionFactory = ({ net, usage, model }) =>
  new FixtureDecision(net, { usage, model });

describe('decision@1 control: the kit passes a faithful plugin', () => {
  it('reports no failures for the fixture decision model', async () => {
    expect(await checkDecision(faithful, { template: fixtureDecisionTemplate })).toEqual([]);
  });

  it('fires its own timeout when a plugin simply never answers (meta-control)', async () => {
    const failures = await kit(
      () => ({ decide: () => new Promise<DecisionResponse>(() => undefined) }),
      'single choice',
      150,
    );
    expect(messages(failures)).toMatch(
      /a single choice question is answered and satisfies validateDecisionExchange timed out after 150 ms/,
    );
  });
});

describe('decision@1 rejects a plugin that ignores the abort signal', () => {
  const deaf: DecisionFactory = ({ net, usage, model }) => {
    const real = new FixtureDecision(net, { usage, model });
    return { decide: (request) => real.decide(request, { signal: new AbortController().signal }) };
  };

  it('flags a decide() that answers an already-aborted call', async () => {
    const failures = await kit(deaf, 'aborted decide');
    expect(messages(failures)).toMatch(
      /decide\(\) resolved although its signal was already aborted/,
    );
    expect(messages(failures)).toMatch(
      /a provider request went out although the signal was already aborted/,
    );
  });

  it('flags a decide() that runs an aborted call to completion', async () => {
    const failures = await kit(deaf, 'aborted decide');
    expect(messages(failures)).toMatch(
      /decide\(\) returned an answer although the call was aborted mid-flight/,
    );
    expect(messages(failures)).toMatch(/ms to give up after a 30 ms abort of an 800 ms call/);
  });
});

describe('decision@1 rejects a plugin that reaches a host other than its own', () => {
  it('flags a global fetch that bypasses the NetPort entirely', async () => {
    const failures = await kit(({ net, usage, model }) => {
      const real = new FixtureDecision(net, { usage, model });
      return {
        async decide(request, options) {
          await fetch('https://decisions.example/v1/decide', { method: 'POST' });
          return real.decide(request, options);
        },
      };
    }, 'no network bypasses');
    expect(messages(failures)).toMatch(
      /Egress blocked by the conformance sentinel: fetch https:\/\/decisions\.example\/v1\/decide/,
    );
    expect(messages(failures)).toMatch(
      /network bypassed the NetPort: fetch https:\/\/decisions\.example\/v1\/decide/,
    );
  });

  it('flags a second host reached through the NetPort', async () => {
    const failures = await kit(({ net, usage, model }) => {
      const real = new FixtureDecision(net, { usage, model });
      return {
        async decide(request, options) {
          await net.fetch('https://other.invalid/v1/decide', { method: 'POST' });
          return real.decide(request, options);
        },
      };
    }, 'no network bypasses');
    expect(messages(failures)).toMatch(
      /FixtureNet mismatch on other\.invalid: expected no script for this host/,
    );
  });
});

describe('decision@1 rejects a plugin that rewrites or fans out the request', () => {
  it('flags criteria re-labelled as index numbers before they reach the provider', async () => {
    const failures = await kit(({ net, usage, model }) => {
      const real = new FixtureDecision(net, { usage, model });
      return {
        decide(request, options) {
          const questions = Object.fromEntries(
            Object.entries(request.questions).map(([id, question]) => [
              id,
              question.type === 'choice'
                ? {
                    ...question,
                    criteria: Object.fromEntries(
                      Object.values(question.criteria).map((text, index) => [`c${index}`, text]),
                    ),
                  }
                : question,
            ]),
          ) as Record<string, DecisionQuestion>;
          return real.decide({ ...request, questions }, options);
        },
      };
    }, 'criterion key');
    expect(messages(failures)).toMatch(/the request omits criterion key opt_/);
  });

  it('flags one provider request per question instead of one for the batch', async () => {
    const failures = await kit(({ net, usage, model }) => {
      const real = new FixtureDecision(net, { usage, model });
      return {
        async decide(request, options) {
          const answers: Record<string, unknown> = {};
          let modelId = '';
          for (const [id, question] of Object.entries(request.questions)) {
            const one = await real.decide(
              { state: request.state, questions: { [id]: question } },
              options,
            );
            modelId = one.modelId;
            Object.assign(answers, one.answers);
          }
          return { modelId, answers } as DecisionResponse;
        },
      };
    }, 'single exchange');
    expect(messages(failures)).toMatch(
      /6 questions in one request produced 0 provider calls; a slot that fans out costs one round trip per question/,
    );
    expect(messages(failures)).toMatch(/FixtureNet mismatch on fixture\.invalid/);
  });
});

describe('decision@1 rejects a plugin that mis-meters a decision', () => {
  const metering = (meter: UsageMeter): DecisionFactory => {
    return ({ net, usage, model }) => {
      const real = new FixtureDecision(net, { usage, model });
      return {
        async decide(request, options) {
          const response = await real.decide(request, options);
          usage(meter);
          return response;
        },
      };
    };
  };
  const extra: UsageMeter = {
    provider: 'fixture',
    operation: 'decision',
    unit: 'input_tokens',
    quantity: '1',
    state: 'estimated',
    requestId: 'fixture:kit-session:dup',
    elapsedMs: 0,
  };

  it('flags a second usage meter per decide()', async () => {
    const failures = await kit(metering(extra), 'usage is emitted');
    expect(messages(failures)).toMatch(
      /usage: 4 meters for 2 decisions; a decision is metered at most once/,
    );
  });

  it('flags a decision billed as an LLM call', async () => {
    const failures = await kit(metering({ ...extra, operation: 'inference' }), 'usage is emitted');
    expect(messages(failures)).toMatch(
      /usage: a meter arrived with operation 'inference'; a decision is priced as a decision, not as an LLM call/,
    );
  });
});
