// The STT bake-off and gold-reference tool (Wave 13, S1-S3).
//
//   tsx packages/eval/src/stt/cli.ts status [--keys ~/.ovo-eval/keys.env]
//       every configuration and whether it can run (ready, pending key, pending plugin)
//   tsx packages/eval/src/stt/cli.ts draft --corpus ~/work/ovo-waves --calls call7,call8
//       segment and align each caller track; writes a gold skeleton where none exists, or adds
//       the regions it lacks where the live call turned near-silence into a user turn
//   tsx packages/eval/src/stt/cli.ts record --corpus <dir> --configs scribe-auto,... --keys <file>
//       LIVE: streams the gold utterances through each configuration in real time (costs money);
//       --limit N streams only the first N utterances of each call, a smoke test; --only c8-n
//       streams only the regions with those id prefixes and merges them into the recording
//   tsx packages/eval/src/stt/cli.ts batch --corpus <dir> --configs scribe-v2-batch,aai-batch --keys <file>
//       LIVE: batch transcripts as a second opinion for the gold references
//   tsx packages/eval/src/stt/cli.ts candidates
//       copies every recorded transcript into the gold files' `candidates`
//   tsx packages/eval/src/stt/cli.ts score [--configs a,b] [--json out.json]
//       offline: scores the recorded runs against the gold and prints the markdown report
//
// Live commands refuse to start when the spend ledger plus the planned audio would pass the budget
import { parseArgs } from 'node:util';
import { batch, record } from './live.ts';
import { candidates, draft, score, status } from './offline.ts';

export { GOLD_DIR, RUNS_DIR, loadGolds, loadRuns, merge } from './store.ts';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      corpus: { type: 'string' },
      calls: { type: 'string' },
      configs: { type: 'string' },
      keys: { type: 'string' },
      json: { type: 'string' },
      'budget-min': { type: 'string' },
      /** Only the first N utterances of each call: a smoke test before a full pass. */
      limit: { type: 'string' },
      /** Only regions whose id starts with one of these, merged into the existing recording. */
      only: { type: 'string' },
    },
  });
  const commands = { status, draft, record, batch, candidates, score } as const;
  const command = commands[positionals[0] as keyof typeof commands];
  if (!command) throw new Error(`usage: cli.ts ${Object.keys(commands).join('|')} [options]`);
  if (['draft', 'record', 'batch'].includes(positionals[0]!) && !values.corpus)
    throw new Error('--corpus <dir with callN-caller.wav and callN-events.jsonl> is required');
  await command(values);
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
