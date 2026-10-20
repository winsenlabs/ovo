import type { HoldPolicy, RoutingTransferPolicy } from '@winsendotai/ovo-contracts';

/** An agent request for the controller's `begin`. */
export function agentRequest(releaseId: string, reason: 'route' | 'transfer' = 'transfer') {
  return {
    kind: 'agent' as const,
    reason,
    agentId: `agent-of-${releaseId}`,
    releaseId,
    variables: { ovo_route_intent: 'billing' },
    ...(reason === 'transfer' ? { transfer: { source: 'llm' as const, key: 'billing' } } : {}),
  };
}

export const signal = () => new AbortController().signal;

export const holdPolicy = (overrides: Partial<HoldPolicy> = {}): HoldPolicy => ({
  steps: [{ kind: 'silence', seconds: 3 }],
  loopFrom: 0,
  maxSeconds: 30,
  waitForCapacity: false,
  onTimeout: [{ kind: 'end', line: { en: 'Goodbye.' } }],
  ...overrides,
});

export const transferPolicy = (
  overrides: Partial<RoutingTransferPolicy> = {},
): RoutingTransferPolicy => ({
  targets: [],
  confirm: 'never',
  limits: { maxTransfers: 3, returnToPrevious: 'refuse', minRemainingSeconds: 30 },
  handover: { summary: true, transcriptTurns: 6, capturedVariables: true },
  ...overrides,
});
