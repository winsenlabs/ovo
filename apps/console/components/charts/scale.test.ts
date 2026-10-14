import { describe, expect, it } from 'vitest';
import { bandScale, formatInrAxis, formatMsAxis, linearScale, niceTicks } from './scale';

describe('linearScale', () => {
  it('maps the domain onto the range', () => {
    const scale = linearScale([0, 10], [0, 100]);
    expect(scale(0)).toBe(0);
    expect(scale(5)).toBe(50);
    expect(scale(10)).toBe(100);
  });
  it('does not divide by zero for a collapsed domain', () => {
    const scale = linearScale([5, 5], [0, 100]);
    expect(Number.isFinite(scale(5))).toBe(true);
  });
});

describe('bandScale', () => {
  it('spaces band centres evenly and shrinks bandwidth by the padding ratio', () => {
    const { center, bandwidth } = bandScale(4, [0, 400], 0.5);
    expect(center(0)).toBeCloseTo(50);
    expect(center(3)).toBeCloseTo(350);
    expect(bandwidth).toBeCloseTo(50);
  });
});

describe('niceTicks', () => {
  it('returns the single value for a collapsed domain', () => {
    expect(niceTicks([3, 3])).toEqual([3]);
  });
  it('produces round steps covering the domain', () => {
    const ticks = niceTicks([0, 97], 5);
    expect(ticks[0]).toBeGreaterThanOrEqual(0);
    expect(ticks.at(-1)).toBeLessThanOrEqual(97);
    expect(ticks.length).toBeGreaterThan(1);
  });
});

describe('formatMsAxis', () => {
  it('renders sub-second as ms', () => {
    expect(formatMsAxis(820)).toBe('820ms');
  });
  it('renders whole seconds without a decimal', () => {
    expect(formatMsAxis(2000)).toBe('2s');
  });
  it('renders minutes once over 60s', () => {
    expect(formatMsAxis(90000)).toBe('1.5m');
  });
});

describe('formatInrAxis', () => {
  it('renders lakhs for large amounts', () => {
    expect(formatInrAxis(20000000)).toBe('₹2.0L');
  });
  it('renders thousands for mid-size amounts', () => {
    expect(formatInrAxis(250000)).toBe('₹2.5k');
  });
  it('renders whole rupees for small amounts', () => {
    expect(formatInrAxis(500)).toBe('₹5');
  });
});
