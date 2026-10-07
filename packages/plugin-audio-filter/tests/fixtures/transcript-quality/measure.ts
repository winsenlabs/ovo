// Re-measures transcripts.json: every speech clip under every phone-line condition, with the
// filter off and with each preset, transcribed by an offline ASR (README.md has the setup).
//
//   OVO_ASR_COMMAND='~/vosk/venv/bin/python3 vosk_asr.py ~/vosk/vosk-model-small-en-in-0.4' \
//     pnpm exec tsx packages/plugin-audio-filter/tests/fixtures/transcript-quality/measure.ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONDITIONS,
  FILTERS,
  SPEECH,
  heard,
  noisy,
  type Condition,
  type FilterName,
} from '../phone-noise.ts';

export interface Measured {
  clip: string;
  condition: Condition;
  filter: FilterName;
  /** SHA-256 of the mu-law the ASR heard: the regression test recomputes it. */
  sha256: string;
  transcript: string;
}

export function cases(): Array<Omit<Measured, 'transcript'> & { audio: Uint8Array }> {
  return SPEECH.flatMap((clip, index) =>
    (Object.keys(CONDITIONS) as Condition[]).flatMap((condition) => {
      const line = noisy(index, condition);
      return (Object.keys(FILTERS) as FilterName[]).map((filter) => {
        const audio = heard(line, filter);
        const sha256 = createHash('sha256').update(audio).digest('hex');
        return { clip: clip.id, condition, filter, sha256, audio };
      });
    }),
  );
}

function main() {
  const command = process.env.OVO_ASR_COMMAND?.trim().split(/\s+/);
  if (!command?.length) throw new Error('Set OVO_ASR_COMMAND (README.md)');
  const directory = mkdtempSync(join(tmpdir(), 'ovo-filter-asr-'));
  try {
    const all = cases();
    const names = all.map((item) => `${item.clip}.${item.condition}.${item.filter}.ulaw`);
    all.forEach((item, i) => writeFileSync(join(directory, names[i]!), item.audio));
    const output = execFileSync(
      command[0]!,
      [...command.slice(1), ...names.map((name) => join(directory, name))],
      {
        cwd: new URL('.', import.meta.url).pathname,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const transcripts = new Map(
      output
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t') as [string, string]),
    );
    const measured: Measured[] = all.map(({ audio: _audio, ...item }, i) => ({
      ...item,
      transcript: transcripts.get(names[i]!) ?? '',
    }));
    const result = {
      asr: process.env.OVO_ASR_NAME ?? command.join(' '),
      measuredAt: new Date().toISOString().slice(0, 10),
      measured,
    };
    writeFileSync(
      new URL('./transcripts.json', import.meta.url),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    console.log(`measured ${measured.length} transcripts`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
