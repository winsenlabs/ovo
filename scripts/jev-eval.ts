// The Jev routing eval over the labelled CreditMantri corpus (packages/plugin-evaluations).
//
//   pnpm eval:jev                  replay the committed answers offline; exit 1 when the gate fails
//   pnpm eval:jev --json           the same, as a JSON report
//   pnpm eval:jev --synthesize     rewrite the answers as a label echo (no network; measures nothing)
//   pnpm eval:jev --record --calibration-label <label> [--model jev-latest]
//                                  ask TypeSafe Jev every decided case once and save its answers;
//                                  needs OVO_JEV_EVAL_API_KEY. Run this after any flow change.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import prettier from 'prettier';
import { jevDecision, resolveBinding } from '../packages/plugin-decision-jev/src/index.ts';
import { CREDITMANTRI_JEV_EVAL } from '../packages/plugin-evaluations/src/corpus/jev-eval-creditmantri.ts';
import { runJevEval } from '../packages/plugin-evaluations/src/jev-eval.ts';
import {
  recordJevEval,
  replayDecision,
  synthesizeJevEvalRecording,
  type JevEvalRecording,
} from '../packages/plugin-evaluations/src/jev-eval-recording.ts';
import {
  formatJevEvalReport,
  summarizeJevEval,
} from '../packages/plugin-evaluations/src/jev-eval-report.ts';

const RECORDING = new URL(
  '../packages/plugin-evaluations/src/corpus/jev-eval-creditmantri.recording.json',
  import.meta.url,
).pathname;

const { values } = parseArgs({
  options: {
    json: { type: 'boolean' },
    synthesize: { type: 'boolean' },
    record: { type: 'boolean' },
    'calibration-label': { type: 'string' },
    model: { type: 'string' },
  },
});

async function save(recording: JevEvalRecording) {
  const style = await prettier.resolveConfig(RECORDING);
  await writeFile(
    RECORDING,
    await prettier.format(JSON.stringify(recording), { ...style, parser: 'json' }),
  );
  console.error(`Wrote ${Object.keys(recording.answers).length} answers to ${RECORDING}`);
}

async function run(): Promise<number> {
  const set = CREDITMANTRI_JEV_EVAL;
  const now = new Date().toISOString();
  if (values.synthesize) {
    await save(synthesizeJevEvalRecording(set, now));
    return 0;
  }
  if (values.record) {
    const apiKey = process.env.OVO_JEV_EVAL_API_KEY;
    if (!apiKey) throw new Error('--record needs OVO_JEV_EVAL_API_KEY');
    const binding = resolveBinding({
      calibrationLabel: values['calibration-label'],
      ...(values.model ? { model: values.model } : {}),
    });
    const live = jevDecision({ fetch: (url, init) => fetch(url, init) }, apiKey, binding);
    await save(
      await recordJevEval(set, live, {
        note: `Live answers from ${binding.model} at ${binding.endpoint}.`,
        recordedAt: now,
      }),
    );
    return 0;
  }
  const recording = JSON.parse(await readFile(RECORDING, 'utf8')) as JevEvalRecording;
  const report = summarizeJevEval(await runJevEval(set, replayDecision(recording)), set.gate);
  if (values.json)
    console.log(JSON.stringify({ provenance: recording.provenance, report }, null, 2));
  else
    console.log(
      formatJevEvalReport(report, [
        `Jev eval: ${set.name}, ${set.cases.length} labelled replies`,
        `Answers: ${recording.provenance} (${recording.modelId ?? 'unknown model'}, ${recording.recordedAt})`,
        ...(recording.provenance === 'synthetic' ? [`NOTE: ${recording.note}`] : []),
      ]),
    );
  return report.gate.passed ? 0 : 1;
}

process.exitCode = await run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
