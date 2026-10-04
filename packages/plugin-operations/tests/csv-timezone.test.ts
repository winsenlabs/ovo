import { describe, expect, it } from 'vitest';
import {
  exportCampaignContacts,
  previewCampaignCsv,
  resolveScheduledInstant,
  sanitizeCsvExportCell,
  ScheduleTimeError,
} from '../src/index.ts';

describe('campaign CSV safety', () => {
  it('validates mapped rows, bounds preview, and neutralizes spreadsheet formulas on export', () => {
    const preview = previewCampaignCsv(
      'phone,customer,note\r\n+14155550100,C-1,"=HYPERLINK(""https://invalid"", ""x"")"\r\ninvalid,C-2,ok\r\n',
      { phone: 'phone', externalId: 'customer', variables: { note: 'note' } },
    );
    expect(preview.rows).toEqual([
      {
        sourceRow: 2,
        phoneNumber: '+14155550100',
        externalId: 'C-1',
        variables: { note: '=HYPERLINK("https://invalid", "x")' },
      },
    ]);
    expect(preview.errors).toEqual([
      { row: 3, field: 'phone', message: 'must be an E.164 phone number' },
    ]);
    expect(exportCampaignContacts(preview.rows)).toContain(
      '"\'=HYPERLINK(""https://invalid"", ""x"")"',
    );
    expect(sanitizeCsvExportCell('+cmd')).toBe("'+cmd");
  });

  it('rejects unknown columns and limits previews to 100 contacts', () => {
    expect(() => previewCampaignCsv('phone\n+1\n', { phone: 'missing' })).toThrow(
      'Unknown CSV column',
    );
    const csv = [
      'phone',
      ...Array.from({ length: 101 }, (_, index) => `+1415555${String(index).padStart(4, '0')}`),
    ].join('\n');
    const preview = previewCampaignCsv(csv, { phone: 'phone' });
    expect(preview.rows).toHaveLength(100);
    expect(preview.truncated).toBe(true);
  });
});

describe('explicit timezone and DST validation', () => {
  it('resolves an unambiguous local minute', () => {
    expect(resolveScheduledInstant('2026-01-15T12:30', 'America/New_York').toISOString()).toBe(
      '2026-01-15T17:30:00.000Z',
    );
  });

  it.each([
    ['2026-03-08T02:30', 'nonexistent'],
    ['2026-11-01T01:30', 'ambiguous'],
  ] as const)('rejects %s as %s in America/New_York', (local, code) => {
    expect(() => resolveScheduledInstant(local, 'America/New_York')).toThrowError(
      expect.objectContaining<Partial<ScheduleTimeError>>({ code }),
    );
  });

  it('rejects invalid IANA zones instead of using the host timezone', () => {
    expect(() => resolveScheduledInstant('2026-01-15T12:30', 'Mars/Olympus')).toThrowError(
      expect.objectContaining<Partial<ScheduleTimeError>>({ code: 'invalid_timezone' }),
    );
  });
});
