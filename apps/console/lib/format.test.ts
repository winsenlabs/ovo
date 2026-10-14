import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatPaise,
  formatPercent,
  formatPhoneNumber,
  formatQuantity,
  shortenId,
} from './format';

describe('formatDuration', () => {
  it('renders sub-second values in ms', () => {
    expect(formatDuration(820)).toBe('820 ms');
  });
  it('renders minutes and seconds', () => {
    expect(formatDuration(228520)).toBe('3m 48s');
  });
  it('renders hours and minutes once over an hour', () => {
    expect(formatDuration(3_725_000)).toBe('1h 2m');
  });
  it('is honest about missing data', () => {
    expect(formatDuration(null)).toBe('Unknown');
    expect(formatDuration(undefined)).toBe('Unknown');
  });
});

describe('formatMoney', () => {
  it('converts paise to rupees with en-IN grouping', () => {
    expect(formatMoney(173400050, 'INR')).toBe('₹17,34,000.50');
  });
  it('is honest when unpriced', () => {
    expect(formatMoney(null)).toBe('Unpriced');
  });
  it('falls back for a malformed currency code without throwing', () => {
    expect(formatMoney(100, 'not-a-code')).toContain('not-a-code');
  });
});

describe('formatPaise (legacy, unchanged)', () => {
  it('still formats a paise string as before', () => {
    expect(formatPaise('173400050')).toBe('₹17,34,000.50');
  });
  it('still reports unpriced for null', () => {
    expect(formatPaise(null)).toBe('unpriced');
  });
});

describe('formatPercent', () => {
  it('formats a ratio as a whole percent when it divides evenly', () => {
    expect(formatPercent(0.1)).toBe('10%');
  });
  it('keeps one decimal when the value needs it', () => {
    expect(formatPercent(0.943)).toBe('94.3%');
  });
});

describe('formatPhoneNumber', () => {
  it('groups an Indian E.164 number', () => {
    expect(formatPhoneNumber('+919820000000')).toBe('+91 98200 00000');
  });
  it('falls back to the raw value for anything unrecognised', () => {
    expect(formatPhoneNumber('not-a-number')).toBe('not-a-number');
  });
});

describe('formatQuantity', () => {
  it('humanises a known pricing unit', () => {
    expect(formatQuantity(7831, 'uncached_input_tokens')).toBe('7,831 input tokens');
  });
  it('appends a seconds-of-audio unit without a leading space', () => {
    expect(formatQuantity(229, 'audio_seconds')).toBe('229s audio');
  });
});

describe('shortenId', () => {
  it('shortens a long id with an ellipsis', () => {
    expect(shortenId('cmp_8f3a2b9c1d0e')).toBe('cmp_8f3a…d0e');
  });
  it('leaves a short id untouched', () => {
    expect(shortenId('rel_1')).toBe('rel_1');
  });
});

describe('formatDate / formatDateTime', () => {
  it('is honest about an invalid date', () => {
    expect(formatDate('not-a-date')).toBe('Unknown');
    expect(formatDateTime('not-a-date')).toBe('Unknown');
  });
  it('formats a real date without throwing', () => {
    expect(formatDate('2026-10-15T00:00:00.000Z')).not.toBe('Unknown');
  });
});
