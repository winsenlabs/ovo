import { describe, expect, it } from 'vitest';
import { RoutingHours } from '@winsendotai/ovo-contracts';
import { isOpen, localTime } from '../src/hours.ts';

const hours = (raw: Record<string, unknown>) => RoutingHours.parse(raw);
const at = (iso: string) => Date.parse(iso);

// 2026-10-15 is a Thursday; Kolkata is UTC+5:30 all year.
const office = hours({
  timezone: 'Asia/Kolkata',
  weekly: { thu: [{ start: '09:00', end: '18:00' }], fri: [{ start: '00:00', end: '23:59' }] },
});

describe('isOpen: window boundaries', () => {
  it.each([
    ['one minute before the start', '2026-10-15T03:29:59Z', false],
    ['the start minute', '2026-10-15T03:30:00Z', true],
    ['the last open minute', '2026-10-15T12:29:59Z', true],
    ['the end minute (excluded)', '2026-10-15T12:30:00Z', false],
    ['local midnight on an all-day window', '2026-10-15T18:30:00Z', true],
  ])('%s', (_name, iso, open) => {
    expect(isOpen(office, at(iso))).toBe(open);
  });

  it('opens any of several windows in a day', () => {
    const split = hours({
      timezone: 'Asia/Kolkata',
      weekly: {
        thu: [
          { start: '09:00', end: '13:00' },
          { start: '14:00', end: '18:00' },
        ],
      },
    });
    expect(isOpen(split, at('2026-10-15T07:00:00Z'))).toBe(true); // 12:30
    expect(isOpen(split, at('2026-10-15T08:00:00Z'))).toBe(false); // 13:30 lunch
    expect(isOpen(split, at('2026-10-15T09:00:00Z'))).toBe(true); // 14:30
  });
});

describe('isOpen: days and dates', () => {
  it('treats a day missing from weekly as closed', () => {
    const mondays = hours({
      timezone: 'Asia/Kolkata',
      weekly: { mon: [{ start: '00:00', end: '23:59' }] },
    });
    expect(isOpen(mondays, at('2026-10-15T06:30:00Z'))).toBe(false);
    expect(isOpen(mondays, at('2026-10-19T06:30:00Z'))).toBe(true);
  });

  it('closes a closed local date all day, on the local calendar not the UTC one', () => {
    const holiday = hours({ ...office, closed: ['2026-10-16'] });
    // 20:00 UTC on the 15th is 01:30 on Friday the 16th in Kolkata.
    expect(isOpen(office, at('2026-10-15T20:00:00Z'))).toBe(true);
    expect(isOpen(holiday, at('2026-10-15T20:00:00Z'))).toBe(false);
    expect(isOpen(holiday, at('2026-10-15T06:30:00Z'))).toBe(true);
  });

  it('reads the weekday in the zone: Thursday night in New York is Friday in Kolkata', () => {
    expect(localTime('America/New_York', at('2026-10-16T02:00:00Z')).weekday).toBe('thu');
    expect(localTime('Asia/Kolkata', at('2026-10-16T02:00:00Z')).weekday).toBe('fri');
  });

  it('throws for a zone the runtime does not know', () => {
    const raw = { timezone: 'Mars/Olympus', weekly: {}, closed: [] };
    expect(() => isOpen(raw, Date.now())).toThrow(RangeError);
    expect(RoutingHours.safeParse(raw).success).toBe(false);
  });
});

describe('isOpen: daylight saving edges (America/New_York, 2026)', () => {
  const sunday = (windows: { start: string; end: string }[]) =>
    hours({ timezone: 'America/New_York', weekly: { sun: windows } });

  it('spring forward: 02:00-03:00 local never happens on 8 March', () => {
    const skipped = sunday([{ start: '02:00', end: '03:00' }]);
    expect(isOpen(skipped, at('2026-03-08T06:59:00Z'))).toBe(false); // 01:59 EST
    expect(isOpen(skipped, at('2026-03-08T07:00:00Z'))).toBe(false); // 03:00 EDT
  });

  it('spring forward: windows either side follow the wall clock', () => {
    const around = sunday([
      { start: '01:00', end: '02:00' },
      { start: '03:00', end: '04:00' },
    ]);
    expect(isOpen(around, at('2026-03-08T06:59:00Z'))).toBe(true); // 01:59 EST
    expect(isOpen(around, at('2026-03-08T07:00:00Z'))).toBe(true); // 03:00 EDT
    expect(isOpen(around, at('2026-03-08T08:00:00Z'))).toBe(false); // 04:00 EDT
  });

  it('fall back: 01:00-02:00 is open through both 01:30s on 1 November', () => {
    const repeated = sunday([{ start: '01:00', end: '02:00' }]);
    expect(isOpen(repeated, at('2026-11-01T05:30:00Z'))).toBe(true); // 01:30 EDT
    expect(isOpen(repeated, at('2026-11-01T06:30:00Z'))).toBe(true); // 01:30 EST
    expect(isOpen(repeated, at('2026-11-01T07:00:00Z'))).toBe(false); // 02:00 EST
  });
});
