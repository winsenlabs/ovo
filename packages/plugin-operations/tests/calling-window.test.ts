import { describe, expect, it } from 'vitest';
import {
  callingWindowSchema,
  callingWindowState,
  resolveCallingWindow,
} from '../src/calling-window.ts';
import { ScheduleTimeError } from '../src/timezone.ts';

const kolkata = resolveCallingWindow({ start: '09:00', end: '19:00' }, 'Asia/Kolkata');

describe('calling-hours window', () => {
  it('is open inside the local window and closed at its exclusive end', () => {
    // 09:00 IST is 03:30 UTC.
    expect(callingWindowState(kolkata, new Date('2026-10-06T03:30:00Z'))).toEqual({ open: true });
    expect(callingWindowState(kolkata, new Date('2026-10-06T13:29:00Z'))).toEqual({ open: true });
    expect(callingWindowState(kolkata, new Date('2026-10-06T13:30:00Z'))).toEqual({
      open: false,
      nextOpenAt: new Date('2026-10-07T03:30:00Z'),
    });
  });

  it('opens later the same day before the start, in the window timezone', () => {
    expect(callingWindowState(kolkata, new Date('2026-10-06T01:00:00Z'))).toEqual({
      open: false,
      nextOpenAt: new Date('2026-10-06T03:30:00Z'),
    });
  });

  it('skips weekdays outside the window', () => {
    const weekdays = resolveCallingWindow(
      { start: '10:00', end: '18:00', days: [1, 2, 3, 4, 5] },
      'Asia/Kolkata',
    );
    // Saturday 2026-10-10 12:00 IST.
    expect(callingWindowState(weekdays, new Date('2026-10-10T06:30:00Z'))).toEqual({
      open: false,
      nextOpenAt: new Date('2026-10-12T04:30:00Z'),
    });
  });

  it('keeps an explicit timezone over the campaign default', () => {
    const window = resolveCallingWindow(
      { start: '09:00', end: '17:00', timezone: 'America/New_York' },
      'Asia/Kolkata',
    );
    expect(window.timezone).toBe('America/New_York');
    // 10:00 EDT is 14:00 UTC.
    expect(callingWindowState(window, new Date('2026-10-06T14:00:00Z'))).toEqual({ open: true });
  });

  it('opens after a spring-forward gap at the first minute that exists', () => {
    const window = resolveCallingWindow({ start: '02:30', end: '05:00' }, 'America/New_York');
    // 2026-03-08 01:00 EST; 02:30 does not exist that day, 03:00 EDT (07:00 UTC) does.
    expect(callingWindowState(window, new Date('2026-03-08T06:00:00Z'))).toEqual({
      open: false,
      nextOpenAt: new Date('2026-03-08T07:00:00Z'),
    });
  });

  it('rejects malformed windows and unknown timezones', () => {
    expect(callingWindowSchema.safeParse({ start: '19:00', end: '09:00' }).success).toBe(false);
    expect(callingWindowSchema.safeParse({ start: '9:00', end: '18:00' }).success).toBe(false);
    expect(
      callingWindowSchema.safeParse({ start: '09:00', end: '18:00', days: [1, 1] }).success,
    ).toBe(false);
    expect(() => resolveCallingWindow({ start: '09:00', end: '18:00' }, 'Mars/Olympus')).toThrow(
      ScheduleTimeError,
    );
  });
});
