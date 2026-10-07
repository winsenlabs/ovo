import { describe, expect, it } from 'vitest';
import {
  AgentCompliance,
  complianceLines,
  COMPLIANCE_REFUSALS,
  DEFAULT_OPT_OUT_CLOSING_LINE,
  disclosureLines,
  WorkspaceCompliance,
} from '../src/agent-compliance.ts';

describe('AgentCompliance', () => {
  it('defaults the opt-out block and lists the fixed lines it speaks', () => {
    const compliance = AgentCompliance.parse({
      callingHours: { start: '08:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
      disclosure: { text: 'This call is recorded for quality and compliance.' },
      optOut: {},
    });
    expect(compliance.optOut).toEqual({
      enabled: true,
      phrases: [],
      closingLine: DEFAULT_OPT_OUT_CLOSING_LINE,
    });
    expect(complianceLines(compliance)).toEqual([
      'This call is recorded for quality and compliance.',
      DEFAULT_OPT_OUT_CLOSING_LINE,
    ]);
    expect(complianceLines({ optOut: { ...compliance.optOut!, enabled: false } })).toEqual([]);
  });

  it.each([
    [{ callingHours: { start: '19:00', end: '08:00' } }],
    [{ callingHours: { start: '8:00', end: '19:00' } }],
    [{ callingHours: { start: '08:00', end: '19:00', days: [0] } }],
    [{ disclosure: { text: ' ' } }],
    [{ optOut: { phrases: ['x'] } }],
    [{ unknown: true }],
  ])('rejects %j', (value) => {
    expect(AgentCompliance.safeParse(value).success).toBe(false);
  });

  it('speaks the identity, AI and recording lines in that order, all off by default', () => {
    expect(AgentCompliance.parse({}).disclosures).toBeUndefined();
    const compliance = AgentCompliance.parse({
      category: 'service',
      purpose: 'rbi_recovery',
      disclosure: { text: 'This call is recorded.' },
      disclosures: {
        optOutHint: { text: 'Say stop to stop these calls.' },
        ai: { text: 'I am an automated assistant.' },
        identity: { text: 'This is Example Bank about your loan.' },
      },
      optOut: {},
    });
    expect(disclosureLines(compliance)).toEqual([
      'This is Example Bank about your loan.',
      'I am an automated assistant.',
      'This call is recorded.',
      'Say stop to stop these calls.',
    ]);
    expect(complianceLines(compliance).at(-1)).toBe(DEFAULT_OPT_OUT_CLOSING_LINE);
    expect(AgentCompliance.safeParse({ category: 'marketing' }).success).toBe(false);
  });
});

describe('WorkspaceCompliance', () => {
  it('defaults to the conservative settings the runbook documents', () => {
    const settings = WorkspaceCompliance.parse({});
    expect(settings.enforcement).toEqual({
      series: 'refuse',
      a2pDeclarationRequiredFrom: '2026-11-17',
      abandonedBreaker: 'enforce',
      recoveryCapsAreFloor: true,
      testNumberCaps: 'exempt',
    });
    expect(settings.blackout).toEqual({
      dates: ['01-26', '08-15', '10-02'],
      appliesTo: ['promotional', 'rbi_recovery'],
    });
    expect(settings.complaintSla).toEqual({
      ackHours: 24,
      resolveDays: 7,
      representBusinessDays: 5,
    });
    expect(settings.optOutScope).toBe('all');
    expect(settings.testNumbers).toEqual([]);
    expect(settings.autodialerIntimation).toBeUndefined();
  });

  it('maps every refusal to a status and a message without a number in it', () => {
    for (const [code, [status, message]] of Object.entries(COMPLIANCE_REFUSALS)) {
      expect([409, 422]).toContain(status);
      expect(message).not.toMatch(/\d{6}/);
      expect(code).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
