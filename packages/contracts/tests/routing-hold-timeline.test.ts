import { describe, expect, it } from 'vitest';
import { HoldPolicy, holdTimeline } from '../src/index.ts';

const MUSIC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const policy = (input: Record<string, unknown>) =>
  HoldPolicy.parse({ onTimeout: [{ kind: 'default' }], ...input });
const brief = (input: ReturnType<typeof holdTimeline>) =>
  input.segments.map((s) => `${s.kind}@${s.loop} ${s.fromS}-${s.toS}`);

describe('holdTimeline', () => {
  it('lays steps end to end and loops the whole sequence by default', () => {
    const found = holdTimeline(
      policy({
        steps: [
          { kind: 'silence', seconds: 3 },
          { kind: 'line', line: { en: 'Thanks for holding.' } },
        ],
        maxSeconds: 20,
      }),
    );
    expect(brief(found)).toEqual([
      'silence@0 0-3',
      'line@0 3-7',
      'silence@1 7-10',
      'line@1 10-14',
      'silence@2 14-17',
      'line@2 17-20',
    ]);
    expect(found).toMatchObject({ maxSeconds: 20, timeoutAt: 20 });
  });

  it('loops from loopFrom, skipping the intro steps', () => {
    const found = holdTimeline(
      policy({
        steps: [
          { kind: 'line', line: { en: 'Please hold while we find someone.' } },
          { kind: 'silence', seconds: 5 },
        ],
        loopFrom: 1,
        maxSeconds: 20,
      }),
    );
    expect(brief(found)).toEqual([
      'line@0 0-4',
      'silence@0 4-9',
      'silence@1 9-14',
      'silence@2 14-19',
      'silence@3 19-20',
    ]);
  });

  it('cuts the last segment at maxSeconds', () => {
    const found = holdTimeline(
      policy({ steps: [{ kind: 'silence', seconds: 60 }], maxSeconds: 25 }),
    );
    expect(brief(found)).toEqual(['silence@0 0-25']);
  });

  it('uses real clip durations, the step cut, and a default for unknown clips', () => {
    const steps = [
      { kind: 'clip', assetId: MUSIC },
      { kind: 'clip', assetId: MUSIC, maxSeconds: 8 },
    ];
    const known = holdTimeline(policy({ steps, maxSeconds: 60 }), { clipSeconds: () => 30 });
    expect(brief(known).slice(0, 3)).toEqual(['clip@0 0-30', 'clip@0 30-38', 'clip@1 38-60']);
    const unknown = holdTimeline(policy({ steps: [steps[0]], maxSeconds: 25 }));
    expect(brief(unknown)).toEqual(['clip@0 0-10', 'clip@1 10-20', 'clip@2 20-25']);
    expect(unknown.segments.every((s) => s.lengthUnknown === true)).toBe(true);
    expect(known.segments.some((s) => s.lengthUnknown)).toBe(false);
  });

  it('labels clips by name or short id, and lines by their text', () => {
    const long = 'x'.repeat(80);
    const found = holdTimeline(
      policy({
        steps: [
          { kind: 'clip', assetId: MUSIC },
          { kind: 'line', line: { en: long } },
          { kind: 'silence', seconds: 1 },
        ],
        maxSeconds: 24,
      }),
      { clipName: () => 'Jazz', clipSeconds: () => 5, lineSeconds: 6 },
    );
    expect(found.segments.map((s) => s.label)).toEqual([
      'Clip: Jazz',
      `Line: ${'x'.repeat(39)}…`,
      'Silence',
      'Clip: Jazz',
      `Line: ${'x'.repeat(39)}…`,
      'Silence',
    ]);
    expect(found.segments[1]).toMatchObject({ fromS: 5, toS: 11 });
    const unnamed = holdTimeline(
      policy({ steps: [{ kind: 'clip', assetId: MUSIC }], maxSeconds: 5 }),
    );
    expect(unnamed.segments[0]?.label).toBe('Clip: aaaaaaaa');
  });

  it('prefers the english line and falls back to the first language', () => {
    const hindi = holdTimeline(
      policy({ steps: [{ kind: 'line', line: { hi: 'रुकिए' } }], maxSeconds: 5 }),
    );
    expect(hindi.segments[0]?.label).toBe('Line: रुकिए');
  });

  it('survives an invalid loopFrom, a zero-length clip and a very long loop', () => {
    const invalid = {
      steps: [{ kind: 'silence', seconds: 2 }],
      loopFrom: 5,
      maxSeconds: 6,
    } as never;
    expect(brief(holdTimeline(invalid))).toEqual([
      'silence@0 0-2',
      'silence@1 2-4',
      'silence@2 4-6',
    ]);
    const zero = holdTimeline(
      policy({ steps: [{ kind: 'clip', assetId: MUSIC }], maxSeconds: 5 }),
      { clipSeconds: () => 0 },
    );
    expect(zero.segments.length).toBeLessThanOrEqual(1_000);
    expect(zero.segments.at(-1)?.toS).toBeLessThanOrEqual(5);
    const long = holdTimeline(
      policy({ steps: [{ kind: 'clip', assetId: MUSIC }], maxSeconds: 900 }),
      { clipSeconds: () => 0.1 },
    );
    expect(long.segments).toHaveLength(1_000);
  });

  it('is deterministic', () => {
    const input = policy({ steps: [{ kind: 'silence', seconds: 7 }], maxSeconds: 50 });
    expect(holdTimeline(input)).toEqual(holdTimeline(input));
  });
});
