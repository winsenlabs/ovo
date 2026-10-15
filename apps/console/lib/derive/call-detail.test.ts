import { describe, expect, it } from 'vitest';
import {
  audioSegments,
  costByProvider,
  primaryCost,
  toConversationLines,
  turnMarkers,
} from './call-detail';
import { turn } from '../../tests/inspector-fixtures';

describe('toConversationLines', () => {
  it('matches each non-interim agent line to the next turn, in order', () => {
    const lines = toConversationLines(
      [
        { id: 'a1', speaker: 'Agent', phase: 'played', text: 'Namaste', atMs: 0 },
        { id: 'u1i', speaker: 'User', phase: 'interim', text: 'Haan', atMs: 2000 },
        { id: 'u1', speaker: 'User', phase: 'final', text: 'Haan boliye', atMs: 2300 },
        { id: 'a2', speaker: 'Agent', phase: 'played', text: 'Dhanyavaad', atMs: 3000 },
      ],
      [turn({ turnId: 't1' }), turn({ turnId: 't2', firstAudioMs: 900 })],
    );
    expect(lines.map((line) => line.speaker)).toEqual(['agent', 'caller', 'caller', 'agent']);
    expect(lines[0]!.latencyMs).toBe(700);
    expect(lines[0]!.interim).toBe(false);
    expect(lines[1]!.interim).toBe(true);
    expect(lines[1]!.played).toBe(false);
    expect(lines[3]!.latencyMs).toBe(900);
  });
});

describe('turnMarkers', () => {
  it('offsets each turn start from the call start', () => {
    const markers = turnMarkers(
      [turn({ startedAt: '2026-10-15T10:00:02.000Z' })],
      '2026-10-15T10:00:00.000Z',
    );
    expect(markers).toEqual([{ atMs: 2000, label: 'Turn 1' }]);
  });
  it('is empty without a call start to offset against', () => {
    expect(turnMarkers([turn()], null)).toEqual([]);
  });

  it('thins markers that would land closer together than their own tap target (axe target-size)', () => {
    const start = '2026-10-15T10:00:00.000Z';
    const markers = turnMarkers(
      [
        turn({ turnId: 't1', startedAt: '2026-10-15T10:00:00.000Z' }),
        turn({ turnId: 't2', startedAt: '2026-10-15T10:00:02.000Z' }), // 2s later: too close
        turn({ turnId: 't3', startedAt: '2026-10-15T10:01:00.000Z' }), // 60s later: kept
      ],
      start,
      100_000,
    );
    expect(markers).toEqual([
      { atMs: 0, label: 'Turn 1' },
      { atMs: 60_000, label: 'Turn 3' },
    ]);
  });

  it('drops a marker past the call duration instead of pushing the player off the viewport', () => {
    // A short/failed call whose synthetic turn telemetry still runs past its own duration
    // (reproduced on `/calls/:id` for a failed call: markers at >100% of the track widened the
    // whole page well past 1440px).
    const markers = turnMarkers(
      [
        turn({ turnId: 't1', startedAt: '2026-10-15T10:00:00.000Z' }),
        turn({ turnId: 't2', startedAt: '2026-10-15T10:00:20.000Z' }),
      ],
      '2026-10-15T10:00:00.000Z',
      10_000,
    );
    expect(markers).toEqual([{ atMs: 0, label: 'Turn 1' }]);
  });
});

describe('audioSegments', () => {
  it('maps the recording state to a boolean availability', () => {
    expect(
      audioSegments([
        { track: 'outbound', sequence: 0, state: 'available', bytes: 1, startMs: 0, endMs: 10 },
        { track: 'outbound', sequence: 1, state: 'missing', bytes: 0, startMs: 10, endMs: 20 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 10, available: true },
      { startMs: 10, endMs: 20, available: false },
    ]);
  });
});

describe('primaryCost', () => {
  it('picks the currency with the most lines and sums estimated + reconciled', () => {
    const cost = primaryCost({
      unpriced: ['plivo.carrier.audio_seconds'],
      currencies: [
        { currency: 'USD', estimatedMinor: '5', reconciledMinor: '0', lines: 2 },
        { currency: 'INR', estimatedMinor: '10', reconciledMinor: '90', lines: 4 },
      ],
    });
    // M1: `others` is minor units, same as `totalMinor` — it goes through `formatMoney` now
    // instead of `.toLocaleString()` on the raw minor-unit number (which read as "USD 5" for
    // what is actually 5 cents, a 100x overstatement next to the Cost tab's own figures).
    expect(cost).toEqual({
      currency: 'INR',
      totalMinor: 100,
      provisional: true,
      others: ['$0.05'],
    });
  });
  it('is null with nothing priced yet', () => {
    expect(primaryCost(undefined)).toBeNull();
  });
});

describe('costByProvider', () => {
  it('sums amounts per provider within one currency only', () => {
    const slices = costByProvider(
      [
        {
          id: '1',
          provider: 'twilio',
          quantity: '1',
          unit: 'audio_seconds',
          amountMinor: '10',
          currency: 'USD',
          state: 'reconciled',
          priceCardId: 'p',
          priceCardVersion: '1',
        },
        {
          id: '2',
          provider: 'twilio',
          quantity: '1',
          unit: 'audio_seconds',
          amountMinor: '5',
          currency: 'USD',
          state: 'reconciled',
          priceCardId: 'p',
          priceCardVersion: '1',
        },
        {
          id: '3',
          provider: 'sarvam',
          quantity: '1',
          unit: 'characters',
          amountMinor: '40',
          currency: 'INR',
          state: 'reconciled',
          priceCardId: 'p',
          priceCardVersion: '1',
        },
      ],
      'USD',
    );
    expect(slices).toEqual([{ label: 'twilio', value: 15 }]);
  });
});
