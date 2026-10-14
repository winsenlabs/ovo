// `eval:calls slim`: a corpus small enough to commit, for the offline gate. Each call keeps only
// the events the harness reads, and its caller audio becomes a VAD trace (where the energy VAD heard
// speech, on the call's timeline): no audio leaves the source directory. Turn summaries are kept
// only for calls that have no events. Gold files are copied as they are.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadCorpus } from './corpus/load.ts';
import { traceFromPcm } from './corpus/vad-trace.ts';
import { decodeWav } from './corpus/wav.ts';
import { parseExport, slimExport } from './log/export.ts';

export async function slimCorpus(
  from: string,
  to: string,
  only?: readonly string[],
  log: (line: string) => void = () => undefined,
): Promise<string[]> {
  const calls = await loadCorpus(from, only);
  await mkdir(join(to, 'gold'), { recursive: true });
  const written: string[] = [];
  const write = async (name: string, text: string) => {
    await writeFile(join(to, name), text);
    written.push(name);
  };
  for (const call of calls) {
    const events = [`${call.name}-events.jsonl`, `${call.name}-events.json`].find((name) =>
      existsSync(join(from, name)),
    );
    if (events) {
      const rows = slimExport(parseExport(await readFile(join(from, events), 'utf8')));
      await write(
        `${call.name}-events.jsonl`,
        `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      );
    } else {
      const turns = (await readdir(from)).find((name) => name.startsWith(`${call.name}-turns.`));
      if (turns) {
        await copyFile(join(from, turns), join(to, turns));
        written.push(turns);
      }
    }
    const trace =
      call.vad ??
      (call.audioPath && call.audioOffsetMs !== undefined
        ? traceFromPcm(
            decodeWav(new Uint8Array(await readFile(call.audioPath))),
            call.audioOffsetMs,
            call.profile.vad,
          )
        : undefined);
    if (trace?.source === 'audio')
      await write(`${call.name}-vad.json`, `${JSON.stringify(trace)}\n`);
    const gold = join(from, 'gold', `${call.name}.json`);
    if (existsSync(gold)) {
      await copyFile(gold, join(to, 'gold', `${call.name}.json`));
      written.push(`gold/${call.name}.json`);
    }
    log(`${call.name}: ${written.filter((name) => name.includes(call.name)).join(', ')}`);
  }
  return written;
}
