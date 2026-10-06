// STT-10 bake-off: Scribe v2 realtime vs AssemblyAI vs Sarvam on Indian English and Hinglish.
//
//   pnpm exec tsx scripts/stt-bakeoff/cli.ts
//       score the committed (synthetic) fixture corpus offline; no network
//   pnpm exec tsx scripts/stt-bakeoff/cli.ts --corpus <dir> [--providers scribe,sarvam] [--json]
//       score a recorded corpus offline
//   OVO_BAKEOFF_ELEVENLABS_API_KEY=… OVO_BAKEOFF_ASSEMBLYAI_API_KEY=… OVO_BAKEOFF_SARVAM_API_KEY=… \
//     pnpm exec tsx scripts/stt-bakeoff/cli.ts --corpus <dir> --live
//       stream every utterance through every provider in real time, save the transcripts, score them
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runBakeoff } from './run.ts';
import { isProvider, PROVIDERS, type PriceTable, type ProviderId } from './types.ts';

const HERE = new URL('.', import.meta.url).pathname;

export function parseProviders(value: string | undefined): ProviderId[] {
  if (!value) return [...PROVIDERS];
  const names = value.split(',').map((name) => name.trim());
  const unknown = names.filter((name) => !isProvider(name));
  if (unknown.length) throw new Error(`unknown provider ${unknown.join(', ')}`);
  return names as ProviderId[];
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      corpus: { type: 'string', default: `${HERE}fixtures` },
      providers: { type: 'string' },
      live: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'usd-inr': { type: 'string', default: '88' },
    },
  });
  const prices = JSON.parse(await readFile(`${HERE}prices.json`, 'utf8')) as PriceTable;
  const { summaries, report } = await runBakeoff({
    corpusDir: values.corpus!,
    providers: parseProviders(values.providers),
    live: values.live,
    usdInr: Number(values['usd-inr']),
    prices,
    log: (line) => console.error(line),
  });
  console.log(
    values.json
      ? JSON.stringify(
          summaries.map(({ scores: _scores, ...summary }) => summary),
          null,
          2,
        )
      : report,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
