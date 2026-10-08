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
import { mulawToPcm16 } from '@winsendotai/ovo-audio';
import {
  CONDITIONS,
  FILTERS,
  SPEECH,
  TAKES,
  heard,
  noisy,
  type Condition,
  type FilterName,
} from '../phone-noise.ts';

export interface Measured {
  clip: string;
  condition: Condition;
  /** Which mix of the condition's noise (`TAKES`); always 0 on the clean line. */
  take: number;
  filter: FilterName;
  /** SHA-256 of the mu-law the ASR heard: the regression test recomputes it. */
  sha256: string;
  transcript: string;
}

export function cases(): Array<Omit<Measured, 'transcript'> & { audio: Uint8Array }> {
  return SPEECH.flatMap((clip, index) =>
    (Object.keys(CONDITIONS) as Condition[]).flatMap((condition) =>
      Array.from({ length: CONDITIONS[condition] ? TAKES : 1 }, (_, take) => {
        const line = noisy(index, condition, take);
        return (Object.keys(FILTERS) as FilterName[]).map((filter) => {
          const audio = heard(line, filter);
          const sha256 = createHash('sha256').update(audio).digest('hex');
          return { clip: clip.id, condition, take, filter, sha256, audio };
        });
      }).flat(),
    ),
  );
}

function main() {
  const command = process.env.OVO_ASR_COMMAND?.trim().split(/\s+/);
  if (!command?.length) throw new Error('Set OVO_ASR_COMMAND (README.md)');
  const directory = mkdtempSync(join(tmpdir(), 'ovo-filter-asr-'));
  try {
    const all = cases();
    // Kaldi dithers its features from one random stream, so the same samples transcribe a word
    // differently at another place in the batch. Each distinct audio is heard once, and every
    // case with those samples (a filter that left the line untouched) shares its transcript.
    const keys = all.map((item) =>
      createHash('sha256').update(mulawToPcm16(item.audio)).digest('hex'),
    );
    const unique = [...new Map(all.map((item, i) => [keys[i]!, item.audio])).entries()];
    unique.forEach(([key, audio]) => writeFileSync(join(directory, `${key}.ulaw`), audio));
    const output = execFileSync(
      command[0]!,
      [...command.slice(1), ...unique.map(([key]) => join(directory, `${key}.ulaw`))],
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
      transcript: transcripts.get(`${keys[i]}.ulaw`) ?? '',
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
