import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VoiceSelection } from '@winsendotai/ovo-contracts';
import {
  AUDIO_FILTER_PLUGIN_ID,
  AudioFilterConfigSchema,
  PHONE_AUDIO_FILTER_CONFIG,
} from '../src/index.ts';
import { CONDITIONS, FILTERS, type Condition, type FilterName } from './fixtures/phone-noise.ts';
import { cases, type Measured } from './fixtures/transcript-quality/measure.ts';

const MEASURED = JSON.parse(
  readFileSync(new URL('./fixtures/transcript-quality/transcripts.json', import.meta.url), 'utf8'),
) as { asr: string; measuredAt: string; measured: Measured[] };

/** Word-level edit distance. */
function wordErrors(reference: readonly string[], hypothesis: readonly string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, j) => j);
  for (let i = 1; i <= reference.length; i++) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[hypothesis.length]!;
}

/**
 * Word error rate per condition and filter, in percent, against what the same ASR heard on the
 * clean line with no filter: it measures what the noise, and the filter, change.
 */
function errorRates(): Record<Condition, Record<FilterName, number>> {
  const words = (text: string) => text.split(/\s+/).filter(Boolean);
  const reference = new Map(
    MEASURED.measured
      .filter((item) => item.condition === 'clean' && item.filter === 'off')
      .map((item) => [item.clip, words(item.transcript)]),
  );
  const totals = new Map<string, { errors: number; words: number }>();
  for (const item of MEASURED.measured) {
    const expected = reference.get(item.clip)!;
    const key = `${item.condition}/${item.filter}`;
    const total = totals.get(key) ?? { errors: 0, words: 0 };
    total.errors += wordErrors(expected, words(item.transcript));
    total.words += expected.length;
    totals.set(key, total);
  }
  return Object.fromEntries(
    (Object.keys(CONDITIONS) as Condition[]).map((condition) => [
      condition,
      Object.fromEntries(
        (Object.keys(FILTERS) as FilterName[]).map((filter) => {
          const total = totals.get(`${condition}/${filter}`)!;
          return [filter, Math.round((1000 * total.errors) / total.words) / 10];
        }),
      ),
    ]),
  ) as Record<Condition, Record<FilterName, number>>;
}

describe('the audio filter presets', () => {
  it.each(['telephony', 'telephony-noisy'] as const)(
    '%s is one valid voice.audioFilter row',
    (name) => {
      const preset = FILTERS[name];
      expect(VoiceSelection.parse(preset)).toEqual(preset);
      expect((preset as { plugin?: string }).plugin).toBe(AUDIO_FILTER_PLUGIN_ID);
      expect(AudioFilterConfigSchema.parse(preset.config)).toEqual(preset.config);
    },
  );

  it('the telephony preset is the recommended phone row the plugin ships', () => {
    expect(FILTERS.telephony.config).toEqual(PHONE_AUDIO_FILTER_CONFIG);
  });
});

describe('transcripts with the filter on and off, on noisy 8 kHz phone audio', () => {
  it('were measured on exactly the audio this filter and these fixtures produce', () => {
    // Fails when the filter, a preset, the noise or a clip changes: re-run measure.ts (README.md).
    const current = cases().map(({ clip, condition, filter, sha256 }) => ({
      clip,
      condition,
      filter,
      sha256,
    }));
    expect(
      MEASURED.measured.map(({ clip, condition, filter, sha256 }) => ({
        clip,
        condition,
        filter,
        sha256,
      })),
    ).toEqual(current);
  });

  it('the telephony preset makes no condition worse, and takes mains hum out', () => {
    const rates = errorRates();
    // The ASR's own wobble: two or three words of the 121 in a condition.
    const tolerance = 2.5;
    for (const condition of Object.keys(CONDITIONS) as Condition[])
      for (const filter of ['telephony', 'telephony-noisy'] as const)
        expect(rates[condition][filter], `${condition}/${filter}`).toBeLessThanOrEqual(
          rates[condition].off + tolerance,
        );
    // A clean line is transcribed exactly as without the filter.
    expect(rates.clean).toEqual({ off: 0, telephony: 0, 'telephony-noisy': 0 });
    expect(rates.hum.telephony).toBeLessThanOrEqual(rates.hum.off - 5);
    const sum = (filter: FilterName) =>
      (Object.keys(CONDITIONS) as Condition[]).reduce((total, c) => total + rates[c][filter], 0);
    expect(sum('telephony')).toBeLessThan(sum('off'));
  });
});
