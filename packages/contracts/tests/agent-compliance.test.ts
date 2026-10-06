import { describe, expect, it } from 'vitest';
import {
  AgentCompliance,
  complianceLines,
  DEFAULT_OPT_OUT_CLOSING_LINE,
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
});
