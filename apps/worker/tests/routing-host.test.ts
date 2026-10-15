import type { RoutingMemberCandidate } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createRoutingHost, type RoutingClaims } from '../src/routing-host.ts';

const member = (memberId: string): RoutingMemberCandidate => ({
  poolId: 'pool-1',
  memberId,
  agentId: `agent-${memberId}`,
  releaseId: `release-${memberId}`,
});
const call = {
  callId: 'call-1',
  workspaceId: 'workspace-1',
  routingPointId: 'point-1',
  routingReleaseId: 'routing-release-1',
  variables: {},
};
const host = (claims?: Pick<RoutingClaims, 'claim'>, audit = vi.fn()) =>
  createRoutingHost({
    call,
    jobId: 'job-1',
    maxCallSeconds: 600,
    ...(claims ? { claims } : {}),
    external: { enabled: false, workspaceId: 'workspace-1', secrets: { resolve: vi.fn() } },
    audit,
    now: () => 42,
  });

describe('the routing host (Cap.routing)', () => {
  it('claims through operations with the job id and a ttl of the call limit plus 120 s', async () => {
    const claim = vi.fn(async () => ({
      kind: 'claimed' as const,
      claimId: 'claim-1',
      candidate: member('en-1'),
    }));
    const tiers = [[member('en-1'), member('en-2')], [member('en-3')]];
    expect(await host({ claim }).claim(tiers, new AbortController().signal)).toEqual({
      kind: 'claimed',
      claimId: 'claim-1',
      candidate: member('en-1'),
    });
    expect(claim).toHaveBeenCalledWith({
      callId: 'job-1',
      routingReleaseId: 'routing-release-1',
      ttlSeconds: 720,
      tiers,
    });
  });

  it('fails open to the first eligible member when claim storage fails', async () => {
    const audit = vi.fn();
    const claim = vi.fn(async () => Promise.reject(new Error('connection refused')));
    const routing = host({ claim }, audit);
    expect(await routing.claim([[], [member('ta-1')]], new AbortController().signal)).toEqual({
      kind: 'unclaimed',
      candidate: member('ta-1'),
      reason: 'claims_unavailable',
    });
    expect(audit).toHaveBeenCalledWith('route.claims.unavailable', { poolId: 'pool-1' });
    // Without claims composed at all, the same.
    expect(await host().claim([[member('ta-1')]], new AbortController().signal)).toMatchObject({
      kind: 'unclaimed',
    });
  });

  it('answers full when no tier has a member, without asking storage', async () => {
    const claim = vi.fn();
    expect(await host({ claim }).claim([[], []], new AbortController().signal)).toEqual({
      kind: 'full',
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it('exposes the call and the clock, and runs the external engine in the host', async () => {
    const routing = host();
    expect(routing.call).toBe(call);
    expect(routing.now()).toBe(42);
    await expect(
      routing.external(
        {
          node: 'intent',
          engine: {
            kind: 'external',
            endpoint: 'https://decide.example.test',
            credentialId: 'cred',
            timeoutMs: 100,
            threshold: 0.5,
            send: { callerId: false, turnText: true, variables: [] },
            slots: [],
          },
          context: { values: {} },
          branches: ['a'],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'disabled' });
  });
});
