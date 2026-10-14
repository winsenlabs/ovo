import { describe, expect, it } from 'vitest';
import {
  firstAudioSeries,
  percentile,
  routeLabel,
  stageBreakdown,
  turnParts,
  turnSummary,
  turnWaterfall,
} from './turn-model';
import { turn } from '../../tests/inspector-fixtures';

describe('turn waterfall model (OBS-7)', () => {
  it('lays the stages out in order and accounts for the measured time', () => {
    const { parts, unattributedMs, overlapMs, totalMs } = turnParts(turn());
    expect(parts).toEqual([
      { key: 'endpoint', ms: 300 },
      { key: 'stt', ms: 120 },
      { key: 'decision', ms: 240 },
      { key: 'text', ms: 20 },
      { key: 'tts', ms: 180 },
      { key: 'carrier', ms: 40 },
    ]);
    // 120 + 240 + 20 + 180 + 40 = 600 of the 700 ms to first audio.
    expect(unattributedMs).toBe(100);
    expect(overlapMs).toBe(0);
    expect(totalMs).toBe(900);
  });

  it('reports overlap when stages sum past the measured time', () => {
    expect(turnParts(turn({ firstAudioMs: 400 })).overlapMs).toBe(200);
  });

  it('labels the tier that answered, the way the POC does', () => {
    expect(routeLabel(turn())).toEqual({ tier: 'jev', text: 'Jev → promise_to_pay 91% · 240 ms' });
    expect(routeLabel(turn({ decision: { ...turn().decision!, ms: 2 } }))?.text).toBe(
      'Jev → promise_to_pay 91% · ready from partials',
    );
    expect(routeLabel(turn({ decision: { ...turn().decision!, modelId: 'ovo.rules' } }))).toEqual({
      tier: 'rule',
      text: 'rule → promise_to_pay 91%',
    });
    expect(routeLabel(turn({ llmCalls: 2 }))).toEqual({
      tier: 'llm',
      text: 'promise_to_pay 91% → LLM ×2',
    });
    expect(
      routeLabel(
        turn({ decision: { ...turn().decision!, outcome: 'timeout', ms: 800 }, llmCalls: 1 }),
      ),
    ).toEqual({ tier: 'error', text: 'decision timeout after 800 ms → LLM' });
    expect(routeLabel(turn({ decision: null }))).toBeUndefined();
  });

  it('summarises caller turns only', () => {
    const turns = [
      turn({ input: 'initial', firstAudioMs: 5_000, decision: null }),
      turn({ firstAudioMs: 600 }),
      turn({ firstAudioMs: 900, llmCalls: 1 }),
      turn({
        firstAudioMs: 300,
        decision: { ...turn().decision!, modelId: 'ovo.rules' },
        interrupted: true,
      }),
    ];
    expect(turnSummary(turns)).toEqual({
      turns: 3,
      p50: 600,
      p95: 900,
      interrupted: 1,
      tiers: { jev: 1, llm: 1, rule: 1 },
    });
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('chart-ready derivations (W14 latency tab)', () => {
  it('builds one waterfall row per turn, capped near the p95 of their totals', () => {
    const turns = [turn(), turn({ turnId: 't2', firstAudioMs: 2_000, llmFirstTokenMs: 900 })];
    const { rows, p95CapMs } = turnWaterfall(turns);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.label).toBe('Turn 1');
    expect(rows[0]!.stages.some((stage) => stage.ms === 120)).toBe(true);
    expect(p95CapMs).toBeGreaterThan(0);
  });

  it('takes the median of each present stage across turns, dropping stages nobody used', () => {
    const turns = [turn(), turn({ turnId: 't2', sttFinalizeMs: 200 })];
    const points = stageBreakdown(turns);
    const stt = points.find((point) => point.category === 'STT final');
    // Nearest-rank percentile of [120, 200] at 0.5 is the lower of the two.
    expect(stt?.values.median).toBe(120);
    expect(points.some((point) => point.category === 'Queue')).toBe(false);
  });

  it('indexes answered turns in order with p50/p95 of their first-audio time', () => {
    const turns = [
      turn({ input: 'initial', firstAudioMs: 50 }),
      turn({ firstAudioMs: 600 }),
      turn({ firstAudioMs: 900 }),
    ];
    const { points, p50, p95 } = firstAudioSeries(turns);
    expect(points).toEqual([
      { x: 1, y: 600 },
      { x: 2, y: 900 },
    ]);
    expect(p50).toBe(600);
    expect(p95).toBe(900);
  });
});
