/**
 * The half of `decision@1` that asks whether the confidence number means anything: it must move
 * between an unambiguous and a genuinely ambiguous input, it must name a calibration cohort, that
 * cohort must change when the model changes, and nothing may round, clamp or substitute the numbers
 * the provider reported. None of this proves the provider IS calibrated — see `decision.ts`.
 */
import type { DecisionRequest } from '@winsendotai/ovo-contracts';
import { answerOf, driveDecision, netFailures } from './decision-harness.ts';
import {
  choiceAnswer,
  choiceOf,
  choicePlan,
  decisionReply,
  modelsOf,
  noulAnswer,
  noulOf,
  runToken,
  stateOf,
  type DecisionKitContext,
} from './decision-support.ts';
import { Failures, type KitCheck } from './runner.ts';

/** `answer.calibrationVersion` as the wire really carried it, not as the type promises. */
const versionOf = (answer: unknown): unknown =>
  (answer as { calibrationVersion?: unknown }).calibrationVersion;

export const DECISION_CONFIDENCE_CHECKS: readonly KitCheck<DecisionKitContext>[] = [
  {
    name: 'confidence moves between an unambiguous and an ambiguous input',
    async run(context) {
      const f = new Failures();
      const plan = choicePlan(context, [
        { said: 'yes, I will pay the full amount today', confidence: 0.96 },
        { said: 'hmm, maybe, I am not sure, it depends', confidence: 0.41 },
      ]);
      const run = await driveDecision(context, plan);
      const sharp = answerOf(f, run, 0, 'confidence spread')?.answers.q_intent?.confidence;
      const vague = answerOf(f, run, 1, 'confidence spread')?.answers.q_intent?.confidence;
      if (sharp !== undefined && vague !== undefined) {
        f.expect(
          Math.abs(sharp - vague) >= 0.1,
          `confidence spread: an unambiguous input returned ${sharp} and a genuinely ambiguous one ${vague}; a plugin whose confidence never moves is not calibrated, it is decorative`,
        );
        f.expect(
          sharp > vague,
          `confidence spread: the ambiguous input (${vague}) was not less confident than the unambiguous one (${sharp})`,
        );
      }
      netFailures(f, run, 'confidence spread');
      return f.messages;
    },
  },
  {
    name: 'every answer identifies its calibration cohort, and the cohort changes with the model',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const { keys, question } = choiceOf(3, token);
      const models = modelsOf(context).slice(0, 2);
      if (models.length < 2)
        return [
          'calibration cohort: the kit needs two bindable models with their own measured cohorts; one model cannot show whether calibrationVersion identifies anything',
        ];
      const seen: { model: string; modelId: string; version: unknown }[] = [];
      for (const [index, model] of models.entries()) {
        const where = `calibration cohort (${model})`;
        const cal = `kit-cal-${token}-${index}`;
        const request: DecisionRequest = {
          state: stateOf(token, `I can pay next week (run ${token})`),
          questions: { q_intent: question, q_commit: noulOf(token) },
        };
        const run = await driveDecision(context, {
          model,
          exchanges: [
            {
              request,
              response: decisionReply(model, {
                q_intent: choiceAnswer(keys, 0, 0.82, cal),
                q_commit: noulAnswer(0.6, 0.71, cal),
              }),
            },
          ],
        });
        netFailures(f, run, where);
        const response = answerOf(f, run, 0, where);
        if (!response) continue;
        const versions = Object.entries(response.answers).map(([id, answer]) => {
          const version = versionOf(answer);
          f.expect(
            typeof version === 'string' && version.length > 0,
            `${where}: answer ${id} carries no calibrationVersion; an unidentifiable calibration cohort makes the confidence number unusable`,
          );
          return version;
        });
        f.expect(
          new Set(versions).size <= 1,
          `${where}: answers in one response disagree on calibrationVersion (${[...new Set(versions)].map(String).join(', ')})`,
        );
        seen.push({ model, modelId: response.modelId, version: versions[0] });
      }
      const [a, b] = seen;
      if (a && b) {
        f.expect(
          a.version !== b.version,
          `calibration cohort: calibrationVersion '${String(a.version)}' is constant across models ${a.model} and ${b.model}; a cohort measured on one model does not transfer to another`,
        );
        f.expect(
          a.modelId !== b.modelId,
          `calibration cohort: modelId '${a.modelId}' is reported for both ${a.model} and ${b.model}; the plugin ignores the model it was bound to`,
        );
      }
      return f.messages;
    },
  },
  {
    name: 'probabilities and confidence are passed through unchanged',
    async run(context) {
      const f = new Failures();
      const plan = choicePlan(context, [{ said: 'an evenly balanced reply' }]);
      const probabilities: Record<string, number> = {
        [plan.keys[0] as string]: 0.4999,
        [plan.keys[1] as string]: 0.0001,
        [plan.keys[2] as string]: 0.5,
      };
      const answer = {
        type: 'choice',
        choice: plan.keys[2],
        confidence: 0.4999,
        calibrationVersion: `kit-cal-${plan.token}`,
        probabilities,
      };
      const run = await driveDecision(context, {
        model: plan.model,
        exchanges: [
          {
            request: plan.requests[0] as DecisionRequest,
            response: decisionReply(plan.model, { q_intent: answer }),
          },
        ],
      });
      const returned = answerOf(f, run, 0, 'pass-through')?.answers.q_intent;
      if (returned) {
        f.expect(
          returned.confidence === 0.4999,
          `pass-through: confidence came back as ${returned.confidence}, not the 0.4999 the provider reported`,
        );
        for (const [key, want] of Object.entries(probabilities))
          f.expect(
            returned.probabilities[key] === want,
            `pass-through: the probability for ${key} came back as ${returned.probabilities[key]}, not ${want}`,
          );
      }
      netFailures(f, run, 'pass-through');
      return f.messages;
    },
  },
];
