/**
 * The turn bake-off (Wave 13, T2). Run on the mini, where the corpus audio and the models are:
 *   OVO_TURN_MODELS_DIR=~/.ovo-eval/models tsx packages/eval/src/turns/cli.ts \
 *     [--corpus ~/work/ovo-waves] [--out <dir>] [--models smart-turn,livekit-audio,livekit-text]
 *     [--sweep]
 * Writes <out>/turn-bakeoff.json and <out>/turn-bakeoff.md. Models that cannot load are skipped
 * (and said so); the rules variants always run. `--sweep` adds threshold variants (audio models).
 *
 * LiveKit's text model runs in a child process: it loads onnxruntime-node 1.24 (through
 * @huggingface/transformers) and Smart Turn 1.30, and the two native libraries cannot share one.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeBakeoffs, runBakeoff, type Bakeoff, type ModelEntry } from './bakeoff.ts';
import { renderReport } from './report.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback;
};
const corpusDir = flag('corpus', join(homedir(), 'work', 'ovo-waves'));
const out = flag('out', join(process.cwd(), 'turn-bakeoff'));
const part = flag('part', '');
const wanted = flag('models', 'smart-turn,livekit-audio,livekit-text').split(',').filter(Boolean);
const sweep = args.includes('--sweep');
/**
 * The gate settings tried for each model: its own design (read once, hold up to 2.5 s), a shorter
 * hold, a shorter hold with questions let through, and audio models reading held turns again.
 */
function entries(key: string, model: ModelEntry['model']): ModelEntry[] {
  const out: ModelEntry[] = [
    { key, model, twin: true },
    { key: `${key} hold 1500`, model, gate: { holdMs: 1500 } },
    {
      key: `${key} hold 1500 +questions`,
      model,
      gate: { holdMs: 1500, safety: { questions: true } },
    },
  ];
  if (model.input === 'audio')
    out.push(
      { key: `${key} recheck 300`, model, gate: { recheckMs: 300 }, twin: true },
      { key: `${key} recheck 150`, model, gate: { recheckMs: 150 } },
    );
  return out;
}

const isolate = !part && wanted.includes('livekit-text') && wanted.length > 1;
const here = isolate ? wanted.filter((key) => key !== 'livekit-text') : wanted;
const models: ModelEntry[] = [];
const skipped: string[] = [];
for (const key of here) {
  try {
    if (key === 'smart-turn') {
      const { SmartTurnModel, SMART_TURN } =
        await import('../../../plugin-turn-detector-smart-turn/src/index.ts');
      const dir = process.env.OVO_TURN_MODELS_DIR;
      if (!dir) throw new Error('OVO_TURN_MODELS_DIR is not set');
      const model = await SmartTurnModel.load({
        modelPath: join(dir, 'smart-turn', SMART_TURN.file),
      });
      models.push(...entries(key, model));
      if (sweep)
        for (const threshold of [0.3, 0.7])
          models.push({
            key: `${key}@${threshold} recheck 300`,
            model,
            gate: { threshold, recheckMs: 300 },
          });
    } else if (key === 'livekit-audio') {
      const { LiveKitAudioModel } =
        await import('../../../plugin-turn-detector-livekit/src/index.ts');
      const model = new LiveKitAudioModel();
      models.push(...entries(key, model));
      if (sweep)
        for (const threshold of [0.2, 0.5])
          models.push({
            key: `${key}@${threshold} recheck 300`,
            model,
            gate: { threshold, recheckMs: 300 },
          });
    } else if (key === 'livekit-text') {
      const { LiveKitTextModel } =
        await import('../../../plugin-turn-detector-livekit/src/index.ts');
      models.push(...entries(key, await LiveKitTextModel.load()));
    } else throw new Error('unknown model');
  } catch (error) {
    skipped.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const parts: Bakeoff[] = [
  await runBakeoff({ corpusDir, models, log: (line) => console.error(line) }),
];
if (part) {
  writeFileSync(part, JSON.stringify({ ...parts[0], skipped }));
  process.exit(0);
}
mkdirSync(out, { recursive: true });
if (isolate) {
  const file = join(out, 'livekit-text.part.json');
  const child = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      '--models',
      'livekit-text',
      '--corpus',
      corpusDir,
      '--part',
      file,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], env: process.env },
  );
  if (child.status === 0) {
    const result = JSON.parse(readFileSync(file, 'utf8')) as Bakeoff & { skipped: string[] };
    parts.push(result);
    skipped.push(...result.skipped);
  } else skipped.push(`livekit-text: child process exited ${child.status ?? child.signal}`);
}
const result = mergeBakeoffs(parts);
writeFileSync(
  join(out, 'turn-bakeoff.json'),
  `${JSON.stringify({ ...result, skipped }, null, 1)}\n`,
);
const report = renderReport(result, skipped);
writeFileSync(join(out, 'turn-bakeoff.md'), report);
console.log(report);
process.exit(0);
