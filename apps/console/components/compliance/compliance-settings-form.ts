import type { ComplianceSettings } from './compliance-types';

const lines = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);

/** The settings the form edits, merged over everything else the workspace has set. */
export function settingsFromForm(
  current: ComplianceSettings,
  values: FormData,
): ComplianceSettings {
  const text = (name: string) => String(values.get(name) ?? '').trim();
  const intimation = ['submittedAt', 'oap', 'objective', 'documentRef'].map((key) => text(key));
  return {
    ...current,
    sender: {
      regulator: text('regulator') || 'other',
      ...(text('legalName') ? { legalName: text('legalName') } : {}),
      ...(text('dltPrincipalEntityId')
        ? { dltPrincipalEntityId: text('dltPrincipalEntityId') }
        : {}),
    },
    ...(intimation.every(Boolean)
      ? {
          autodialerIntimation: {
            submittedAt: intimation[0]!,
            oap: intimation[1]!,
            objective: intimation[2]!,
            documentRef: intimation[3]!,
          },
        }
      : { autodialerIntimation: undefined }),
    enforcement: {
      ...current.enforcement,
      series: text('series') as 'refuse' | 'warn',
      a2pDeclarationRequiredFrom: text('a2pDeclarationRequiredFrom'),
      abandonedBreaker: text('abandonedBreaker') as 'enforce' | 'monitor',
      testNumberCaps: text('testNumberCaps') as 'exempt' | 'enforce',
    },
    optOutScope: text('optOutScope') as 'all' | 'promotional',
    testNumbers: lines(values.get('testNumbers')),
    blackout: { ...current.blackout, dates: lines(values.get('blackoutDates')) },
    complaintSla: {
      ...current.complaintSla,
      ackHours: Number(text('ackHours')),
      resolveDays: Number(text('resolveDays')),
    },
  };
}
