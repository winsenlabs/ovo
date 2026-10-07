import { describe, expect, it } from 'vitest';
import { WorkspaceCompliance, type WindowRule } from '@winsendotai/ovo-contracts';
import {
  GENERIC_PACK,
  IN_TCCCPR_2026_10,
  layerOpen,
  layersState,
  policyProblems,
  settingsProblems,
  windowLayers,
  type CompliancePolicy,
  type WindowLayer,
} from '../../src/index.ts';

const IN = IN_TCCCPR_2026_10;
const defaults = WorkspaceCompliance.parse({});
const allDay = { rules: [{ start: '00:00', end: '23:59' }] };
/** A wall-clock time in India as an instant: `ist('2026-10-07T09:00')`. */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const window = (start: string, end: string, timezone = 'Asia/Kolkata', days?: number[]) => ({
  rules: [{ start, end, ...(days ? { days } : {}) }],
  timezone,
});
const service = (extra: Partial<CompliancePolicy> = {}): CompliancePolicy => ({
  version: 1,
  category: 'service',
  ...extra,
});
const state = (policy: CompliancePolicy, at: Date, settings = defaults, pack = IN) =>
  layersState(windowLayers(pack, settings, policy), at);

describe('calling windows only narrow (G4)', () => {
  it('refuses a campaign window wider than the agent window, intersects a narrower one', () => {
    const agentWindow = window('10:00', '19:00');
    const wide = service({ agentWindow, campaignWindow: window('07:00', '22:00') });
    expect(policyProblems(IN, defaults, wide, { requireCategory: true })).toEqual([
      expect.objectContaining({ code: 'policy_widens_floor', source: 'campaign' }),
    ]);
    const narrow = service({ agentWindow, campaignWindow: window('11:00', '15:00') });
    expect(policyProblems(IN, defaults, narrow, { requireCategory: true })).toEqual([]);
    expect(state(narrow, ist('2026-10-07T10:30'))).toEqual({
      open: false,
      nextOpenAt: ist('2026-10-07T11:00'),
    });
    expect(state(narrow, ist('2026-10-07T11:00'))).toEqual({ open: true });
    expect(state(narrow, ist('2026-10-07T14:59'))).toEqual({ open: true });
    expect(state(narrow, ist('2026-10-07T15:00'))).toEqual({
      open: false,
      nextOpenAt: ist('2026-10-08T11:00'),
    });
  });

  it('never opens outside any layer, and opens at the first minute all of them are open', () => {
    // A seeded generator: the same random windows on every run.
    let seed = 7;
    const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    const clock = (minute: number) =>
      `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    const rule = (): WindowRule => {
      const start = Math.floor(random() * 1_200);
      const end = Math.min(1_439, start + 30 + Math.floor(random() * 600));
      const days = [1, 2, 3, 4, 5, 6, 7].filter(() => random() < 0.7);
      return { start: clock(start), end: clock(end), ...(days.length ? { days } : {}) };
    };
    for (let round = 0; round < 40; round += 1) {
      const layers: WindowLayer[] = ['workspace', 'agent', 'campaign'].map((source) => ({
        source: source as WindowLayer['source'],
        timezone: random() < 0.5 ? 'Asia/Kolkata' : 'Europe/London',
        rules: [rule(), rule()],
      }));
      const at = new Date(Date.UTC(2026, 9, 5) + Math.floor(random() * 7 * 1_440) * 60_000);
      const result = layersState(layers, at);
      const allOpen = (instant: Date) => layers.every((layer) => layerOpen(layer, instant));
      expect(result.open).toBe(allOpen(at));
      if (result.open || 'never' in result) continue;
      expect(allOpen(result.nextOpenAt)).toBe(true);
      expect(allOpen(new Date(result.nextOpenAt.getTime() - 60_000))).toBe(false);
    }
  });
});

describe('the recipient is judged in IST (G5)', () => {
  const policy = service({ agentWindow: window('09:00', '21:00', 'UTC') });
  const settings = WorkspaceCompliance.parse({ windows: { service: allDay } });

  it('applies an agent window set in UTC as 09:00-21:00 in India for +91 numbers', () => {
    expect(state(policy, new Date('2026-10-07T03:30:00Z'), settings)).toEqual({ open: true });
    expect(state(policy, new Date('2026-10-07T15:45:00Z'), settings)).toMatchObject({
      open: false,
    });
  });

  it('keeps the agent timezone for numbers outside India', () => {
    expect(state(policy, new Date('2026-10-07T03:30:00Z'), settings, GENERIC_PACK)).toMatchObject({
      open: false,
    });
    expect(state(policy, new Date('2026-10-07T15:45:00Z'), settings, GENERIC_PACK)).toEqual({
      open: true,
    });
  });
});

describe('category floors and purpose overlays (R15, R17)', () => {
  it('refuses promotional calls before 10:00 IST', () => {
    const promotional: CompliancePolicy = { version: 1, category: 'promotional' };
    expect(state(promotional, ist('2026-10-07T09:30'))).toEqual({
      open: false,
      nextOpenAt: ist('2026-10-07T10:00'),
    });
    expect(state(promotional, ist('2026-10-07T20:59'))).toEqual({ open: true });
    expect(state(promotional, ist('2026-10-07T21:00'))).toMatchObject({ open: false });
  });

  it('lets the rule allow a 07:00 service call that only the default window refuses', () => {
    expect(state(service(), ist('2026-10-07T07:00'))).toEqual({
      open: false,
      nextOpenAt: ist('2026-10-07T09:00'),
    });
    const wide = WorkspaceCompliance.parse({ windows: { service: allDay } });
    expect(state(service(), ist('2026-10-07T07:00'), wide)).toEqual({ open: true });
  });

  it('keeps RBI recovery calls inside 08:00-19:00, end exclusive', () => {
    const settings = WorkspaceCompliance.parse({
      windows: { rbi_recovery: { rules: [{ start: '08:00', end: '19:00' }] } },
      blackout: { dates: [] },
    });
    const recovery = service({ purpose: 'rbi_recovery' });
    expect(state(recovery, ist('2026-10-07T07:59'), settings)).toMatchObject({ open: false });
    expect(state(recovery, ist('2026-10-07T08:00'), settings)).toEqual({ open: true });
    expect(state(recovery, ist('2026-10-07T18:59'), settings)).toEqual({ open: true });
    expect(state(recovery, ist('2026-10-07T19:00'), settings)).toMatchObject({ open: false });
    // Even an agent configured for all day cannot call a borrower at 07:30.
    const agent = service({ purpose: 'rbi_recovery', agentWindow: window('00:00', '23:59') });
    expect(policyProblems(IN, settings, agent, { requireCategory: true })).toEqual([
      expect.objectContaining({ code: 'policy_widens_floor', source: 'agent' }),
    ]);
    expect(state(agent, ist('2026-10-07T07:30'), settings)).toMatchObject({ open: false });
  });

  it('refuses workspace defaults that widen a floor', () => {
    const problems = settingsProblems(
      WorkspaceCompliance.parse({
        windows: {
          promotional: { rules: [{ start: '09:00', end: '21:00' }] },
          rbi_recovery: { rules: [{ start: '07:00', end: '19:00' }] },
        },
        enforcement: { a2pDeclarationRequiredFrom: '2027-01-01' },
      }),
    );
    expect(problems.map((problem) => problem.source).sort()).toEqual([
      'enforcement',
      'promotional',
      'rbi_recovery',
    ]);
  });

  it('skips the national-holiday blackout and Sundays for promotional calls', () => {
    const promotional: CompliancePolicy = { version: 1, category: 'promotional' };
    // Friday 2 October is Gandhi Jayanti; Saturday is open; Sunday is outside the default days.
    expect(state(promotional, ist('2026-10-02T12:00'))).toEqual({
      open: false,
      nextOpenAt: ist('2026-10-03T10:00'),
    });
    expect(state(promotional, ist('2026-10-03T21:30'))).toEqual({
      open: false,
      nextOpenAt: ist('2026-10-05T10:00'),
    });
    // Service calls are not blacked out by default (R16: no TRAI time limit).
    expect(state(service(), ist('2026-10-02T12:00'))).toEqual({ open: true });
  });

  it('reports a policy whose windows never meet', () => {
    const disjoint = service({ agentWindow: window('21:00', '22:00') });
    expect(policyProblems(IN, defaults, disjoint, { requireCategory: true })).toEqual([
      expect.objectContaining({ code: 'calling_window_empty' }),
    ]);
    expect(state(disjoint, ist('2026-10-07T12:00'))).toEqual({ open: false, never: true });
  });
});
