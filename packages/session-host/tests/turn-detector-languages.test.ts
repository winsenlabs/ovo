import { describe, expect, it } from 'vitest';
import { turnDetectorConfig } from '../src/turn-detector-languages.ts';

const DEFAULT_DETECTOR = '@winsendotai/ovo-turn-detector-default';
const row = (pluginId: string) => ({ pluginId, config: { cutoffHoldMs: 700 } });

describe('turnDetectorConfig (N4)', () => {
  it("adds the agent's allowed languages to the default detector's config", () => {
    expect(
      turnDetectorConfig(row(DEFAULT_DETECTOR), { languages: { allowed: ['en', 'hi'] } }),
    ).toEqual({
      cutoffHoldMs: 700,
      languages: ['en', 'hi'],
    });
  });

  it('leaves the config alone without languages, or for another detector', () => {
    expect(turnDetectorConfig(row(DEFAULT_DETECTOR), {})).toEqual({ cutoffHoldMs: 700 });
    expect(turnDetectorConfig(row('fixture-detector'), { languages: { allowed: ['en'] } })).toEqual(
      {
        cutoffHoldMs: 700,
      },
    );
  });
});
