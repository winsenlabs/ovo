import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOLD_POLICY,
  effectiveHold,
  HoldPolicy,
  RouteWindow,
  RoutingAgentTarget,
  RoutingPointDraft,
  RoutingPoolTarget,
  RoutingReleaseSnapshot,
  RoutingTarget,
  RoutingTransferPolicy,
  routingAgentRefs,
  routingAudioIds,
  routingDraftIssues,
  routingPoolIds,
  TRANSFER_BUILT_IN_LINES,
  TransferDestination,
  TransferTarget,
  transferLabel,
} from '../src/index.ts';
import { draft, draftInput, snapshotInput } from './routing-fixture.ts';
import {
  BILLING_RELEASE,
  MUSIC,
  POOL_SALES,
  POOL_SUPPORT,
  transferInput,
  transferSnapshotInput,
} from './transfer-fixture.ts';

const policy = () => RoutingTransferPolicy.parse(transferInput());
const snapshotIssues = (input: Record<string, any>) =>
  RoutingReleaseSnapshot.safeParse(input).error?.issues.map((issue) => issue.message) ?? [];

describe('transfer catalogue schemas', () => {
  it('parses the worked example with its defaults', () => {
    const parsed = policy();
    expect(parsed.confirm).toBe('never');
    expect(parsed.limits).toEqual({
      maxTransfers: 3,
      returnToPrevious: 'refuse',
      minRemainingSeconds: 30,
    });
    expect(parsed.handover).toEqual({ summary: true, transcriptTurns: 6, capturedVariables: true });
    expect(parsed.hold).toMatchObject({ loopFrom: 0, maxSeconds: 180, waitForCapacity: true });
    expect(parsed.targets[0]!.destination).toEqual({
      kind: 'pool',
      poolId: POOL_SUPPORT,
      language: 'caller',
      skills: [],
    });
    expect(parsed.targets[2]!.destination).toEqual({
      kind: 'same-pool',
      language: 'caller',
      skills: ['senior'],
    });
    expect(RoutingTransferPolicy.parse({}).targets).toEqual([]);
  });

  it('reuses the R1 tree target shapes for pool and agent destinations', () => {
    const pool = { kind: 'pool', poolId: POOL_SALES, skills: ['senior'] };
    const agent = { kind: 'agent', agent: { agentId: 'billing', release: { kind: 'latest' } } };
    expect(TransferDestination.parse(pool)).toEqual(RoutingPoolTarget.parse(pool));
    expect(TransferDestination.parse(pool)).toEqual(RoutingTarget.parse(pool));
    expect(TransferDestination.parse(agent)).toEqual(RoutingAgentTarget.parse(agent));
    for (const bad of [
      { kind: 'end', line: { en: 'Bye' } },
      { kind: 'node' },
      { kind: 'same-pool', poolId: POOL_SALES },
      { ...pool, poolId: 'sales' },
    ])
      expect(TransferDestination.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('bounds hold policies', () => {
    const hold = { steps: [{ kind: 'silence', seconds: 3 }], onTimeout: [{ kind: 'default' }] };
    expect(HoldPolicy.parse(hold)).toEqual({
      ...hold,
      loopFrom: 0,
      maxSeconds: 120,
      waitForCapacity: false,
    });
    const silence = { kind: 'silence', seconds: 1 };
    for (const bad of [
      { ...hold, steps: [] },
      { ...hold, steps: Array.from({ length: 13 }, () => silence) },
      { ...hold, onTimeout: [] },
      { ...hold, onTimeout: Array.from({ length: 6 }, () => ({ kind: 'default' })) },
      { ...hold, maxSeconds: 4 },
      { ...hold, maxSeconds: 901 },
      { ...hold, loopFrom: 12 },
      { ...hold, steps: [{ kind: 'silence', seconds: 61 }] },
      { ...hold, steps: [{ kind: 'clip', assetId: MUSIC, sha256: 'ABC' }] },
      { ...hold, steps: [{ kind: 'clip', assetId: MUSIC, maxSeconds: 601 }] },
      { ...hold, onTimeout: [{ kind: 'callback', inMinutes: 4, line: { en: 'Bye' } }] },
      { ...hold, extra: true },
    ])
      expect(HoldPolicy.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('bounds targets and the policy', () => {
    const target = transferInput().targets[0];
    expect(TransferTarget.safeParse({ ...target, description: '' }).success).toBe(false);
    expect(TransferTarget.safeParse({ ...target, from: [] }).success).toBe(false);
    expect(TransferTarget.safeParse({ ...target, confirm: 'maybe' }).success).toBe(false);
    const many = Array.from({ length: 33 }, (_, i) => ({ ...target, key: `t${i}` }));
    expect(RoutingTransferPolicy.safeParse({ targets: many }).success).toBe(false);
    expect(RoutingTransferPolicy.safeParse({ limits: { maxTransfers: 11 } }).success).toBe(false);
    expect(RoutingTransferPolicy.safeParse({ handover: { transcriptTurns: 21 } }).success).toBe(
      false,
    );
  });

  it('keeps a draft without transfer exactly as R1 and accepts one with it', () => {
    expect(draft().transfer).toBeUndefined();
    const parsed = RoutingPointDraft.parse({ ...draftInput(), transfer: transferInput() });
    expect(parsed.transfer?.targets.map((t) => t.key)).toEqual([
      'support',
      'another_language',
      'senior',
      'billing',
    ]);
    expect(routingDraftIssues(parsed)).toEqual([]);
  });

  it('picks the hold: the target, else the point, else the default', () => {
    const parsed = policy();
    expect(effectiveHold(parsed, 'support')).toBe(parsed.targets[0]!.hold);
    expect(effectiveHold(parsed, 'senior')).toBe(parsed.hold);
    expect(effectiveHold(parsed)).toBe(parsed.hold);
    expect(effectiveHold(parsed, 'nobody')).toBe(parsed.hold);
    expect(effectiveHold({ ...parsed, hold: undefined }, 'senior')).toBe(DEFAULT_HOLD_POLICY);
    expect(effectiveHold(undefined)).toBe(DEFAULT_HOLD_POLICY);
  });

  it('ships a valid default hold and built-in lines in English and Hindi', () => {
    expect(HoldPolicy.parse(DEFAULT_HOLD_POLICY)).toEqual(DEFAULT_HOLD_POLICY);
    expect(DEFAULT_HOLD_POLICY.onTimeout.at(-1)?.kind).toBe('end');
    for (const lines of Object.values(TRANSFER_BUILT_IN_LINES))
      expect(Object.keys(lines)).toEqual(['en', 'hi']);
    expect(TRANSFER_BUILT_IN_LINES.confirm.en).toContain('{label}');
    const parsed = policy();
    expect(transferLabel(parsed.targets[0]!, 'hi')).toBe('सपोर्ट टीम');
    expect(transferLabel(parsed.targets[1]!, 'en')).toBe('another language');
  });

  it('lists the pools, clips and agent refs a draft names', () => {
    const parsed = RoutingPointDraft.parse({ ...draftInput(), transfer: transferInput() });
    expect(routingPoolIds(parsed)).toEqual([POOL_SALES, POOL_SUPPORT]);
    expect(routingPoolIds(draft())).toEqual([POOL_SALES, POOL_SUPPORT]);
    expect(routingAudioIds(parsed)).toEqual([MUSIC]);
    expect(routingAudioIds(draft())).toEqual([]);
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const withPool = RoutingPointDraft.parse({
      ...draftInput(),
      transfer: {
        targets: [
          {
            key: 'x',
            description: 'x',
            destination: { kind: 'pool', poolId: other },
            hold: {
              steps: [{ kind: 'clip', assetId: other }],
              onTimeout: [{ kind: 'default' }],
            },
          },
        ],
      },
    });
    expect(routingPoolIds(withPool)).toEqual([POOL_SALES, POOL_SUPPORT, other]);
    expect(routingAudioIds(withPool)).toEqual([other]);
    expect(routingAgentRefs(parsed).map((ref) => ref.path)).toContainEqual([
      'transfer',
      'targets',
      3,
      'destination',
      'agent',
    ]);
  });

  it('accepts a window ending at 24:00 and nothing past it', () => {
    expect(RouteWindow.safeParse({ start: '09:00', end: '24:00' }).success).toBe(true);
    expect(RouteWindow.safeParse({ start: '00:00', end: '24:00' }).success).toBe(true);
    expect(RouteWindow.safeParse({ start: '24:00', end: '24:00' }).success).toBe(false);
    expect(RouteWindow.safeParse({ start: '09:00', end: '24:01' }).success).toBe(false);
    expect(RouteWindow.safeParse({ start: '09:00', end: '25:00' }).success).toBe(false);
  });
});

describe('routing release snapshot v2', () => {
  it('accepts v1 without transfer and v2 with it', () => {
    expect(RoutingReleaseSnapshot.parse(snapshotInput()).schemaVersion).toBe(1);
    const v2 = RoutingReleaseSnapshot.parse(transferSnapshotInput());
    expect(v2.schemaVersion).toBe(2);
    expect(v2.releaseIds).toContain(BILLING_RELEASE);
  });

  it('is version 2 exactly when it has a transfer policy', () => {
    const message = 'A snapshot is schemaVersion 2 exactly when it has a transfer policy';
    expect(snapshotIssues({ ...snapshotInput(), schemaVersion: 2 })).toContain(message);
    expect(snapshotIssues({ ...transferSnapshotInput(), schemaVersion: 1 })).toContain(message);
    expect(snapshotIssues({ ...snapshotInput(), schemaVersion: 3 })).not.toEqual([]);
  });

  it('pins clip digests, lists transfer releases and holds transfer pools', () => {
    const unpinnedClip = transferSnapshotInput();
    delete unpinnedClip.transfer.hold.steps[0].sha256;
    expect(snapshotIssues(unpinnedClip)).toEqual([
      'A release snapshot pins every hold clip digest',
    ]);
    const unlisted = transferSnapshotInput();
    unlisted.releaseIds = unlisted.releaseIds.filter((id: string) => id !== BILLING_RELEASE);
    expect(snapshotIssues(unlisted)).toEqual([
      `Release ${BILLING_RELEASE} is referenced but not listed`,
    ]);
    const latest = transferSnapshotInput();
    latest.transfer.targets[3].destination.agent.release = { kind: 'latest' };
    expect(snapshotIssues(latest)).toContain('A release snapshot pins every agent reference');
    const poolless = transferSnapshotInput();
    delete poolless.pools[POOL_SUPPORT];
    poolless.nodes[0].branches[1].target = { kind: 'pool', poolId: POOL_SALES };
    poolless.releaseIds = poolless.releaseIds.filter(
      (id: string) => id !== snapshotInput().releaseIds[4],
    );
    expect(snapshotIssues(poolless)).toEqual(['The snapshot holds every pool a transfer names']);
  });

  it('refuses a snapshot whose transfer policy has a structural error', () => {
    const input = transferSnapshotInput();
    input.transfer.targets[1].destination.node = 'ghost';
    expect(snapshotIssues(input)).toEqual(['routing_transfer_node_unknown: No node ghost']);
  });
});
