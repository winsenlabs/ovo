/**
 * The `decision@1` checks on the contract's boundaries and on a plugin's plumbing: the 2- and
 * 255-criteria ends of a `choice` question, the abort signal, metering, and the rule that a
 * decision plugin reaches exactly one host and only through its injected `NetPort`.
 */
import type { DecisionRequest } from '@winsendotai/ovo-contracts';
import { answerOf, driveDecision, exchangeFailures, netFailures } from './decision-harness.ts';
import {
  choiceAnswer,
  choiceOf,
  choicePlan,
  decisionReply,
  modelsOf,
  runToken,
  stateOf,
  type DecisionKitContext,
} from './decision-support.ts';
import { Failures, type KitCheck } from './runner.ts';

const abortError = () => new DOMException('kit abort', 'AbortError');

export const DECISION_LIMIT_CHECKS: readonly KitCheck<DecisionKitContext>[] = [
  {
    name: 'the 2-criteria and 255-criteria choice boundaries are answered',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const model = modelsOf(context)[0] as string;
      const cal = `kit-cal-${token}`;
      const bounds = [
        { label: '2 criteria', shape: choiceOf(2, `${token}a`) },
        { label: '255 criteria', shape: choiceOf(255, `${token}b`) },
      ];
      const requests: DecisionRequest[] = bounds.map(({ shape }) => ({
        state: stateOf(token, `a reply at the boundary (run ${token})`),
        questions: { q_intent: shape.question },
      }));
      const run = await driveDecision(context, {
        model,
        exchanges: bounds.map(({ shape }, index) => ({
          request: requests[index] as DecisionRequest,
          response: decisionReply(model, {
            q_intent: choiceAnswer(shape.keys, shape.keys.length - 1, 0.74, cal),
          }),
        })),
      });
      bounds.forEach(({ label }, index) => {
        const response = answerOf(f, run, index, label);
        if (response) exchangeFailures(f, requests[index] as DecisionRequest, response, label);
      });
      netFailures(f, run, 'choice boundaries');
      return f.messages;
    },
  },
  {
    name: 'an aborted decide() rejects and never yields an answer',
    async run(context) {
      const f = new Failures();
      const plan = choicePlan(context, [
        { said: 'a reply that will be abandoned', confidence: 0.77 },
      ]);
      const pre = await driveDecision(context, plan, {
        controllerFor: () => {
          const controller = new AbortController();
          controller.abort(abortError());
          return controller;
        },
      });
      f.expect(
        pre.results[0]?.error !== undefined,
        'abort: decide() resolved although its signal was already aborted',
      );
      f.expect(
        pre.bodies.length === 0,
        'abort: a provider request went out although the signal was already aborted',
      );
      netFailures(f, pre, 'abort (pre-aborted)', false);
      const started = Date.now();
      const live = await driveDecision(
        context,
        { model: plan.model, exchanges: plan.exchanges.map((e) => ({ ...e, delayMs: 800 })) },
        {
          clockScale: 1,
          controllerFor: () => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(abortError()), 30);
            return controller;
          },
        },
      );
      const elapsed = Date.now() - started;
      f.expect(
        live.results[0]?.error !== undefined,
        'abort: decide() returned an answer although the call was aborted mid-flight',
      );
      f.expect(
        elapsed < 500,
        `abort: decide() took ${elapsed} ms to give up after a 30 ms abort of an 800 ms call`,
      );
      netFailures(f, live, 'abort (mid-flight)', false);
      return f.messages;
    },
  },
  {
    name: 'usage is emitted at most once per decision, always with a requestId',
    async run(context) {
      const f = new Failures();
      const plan = choicePlan(context, [
        { said: 'the first metered reply', confidence: 0.8 },
        { said: 'the second metered reply', confidence: 0.7, winner: 1 },
      ]);
      const run = await driveDecision(context, plan);
      f.expect(
        run.usage.length <= run.results.length,
        `usage: ${run.usage.length} meters for ${run.results.length} decisions; a decision is metered at most once`,
      );
      for (const meter of run.usage) {
        f.expect(Boolean(meter.requestId), 'usage: a meter arrived without a requestId');
        f.expect(
          meter.operation === 'decision',
          `usage: a meter arrived with operation '${meter.operation}'; a decision is priced as a decision, not as an LLM call`,
        );
      }
      netFailures(f, run, 'usage');
      return f.messages;
    },
  },
  {
    name: 'no network bypasses the NetPort and only the configured host is reached',
    async run(context) {
      const f = new Failures();
      const run = await driveDecision(context, choicePlan(context, [{ said: 'a routine reply' }]));
      f.expect(
        run.declared.length === 1,
        `netport: the plugin's fixture declares ${run.declared.length} hosts; a decision plugin reaches exactly one`,
      );
      answerOf(f, run, 0, 'netport');
      netFailures(f, run, 'netport');
      return f.messages;
    },
  },
];
