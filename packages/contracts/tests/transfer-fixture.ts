import { POOL_SALES, POOL_SUPPORT, SUPPORT_RELEASE, snapshotInput } from './routing-fixture.ts';

export const BILLING_RELEASE = '99999999-9999-4999-8999-999999999999';
export const MUSIC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const MUSIC_SHA = 'a'.repeat(64);

/** The design's worked transfer policy (section 10.2), cut to the fixture's pools. */
export function transferInput(): Record<string, any> {
  return {
    announcement: { en: 'Let me transfer you to the right team. Please stay on the line.' },
    hold: {
      steps: [
        { kind: 'clip', assetId: MUSIC, maxSeconds: 25 },
        { kind: 'line', line: { en: "Thanks for holding, you'll be connected shortly." } },
      ],
      maxSeconds: 180,
      waitForCapacity: true,
      onTimeout: [
        { kind: 'default' },
        { kind: 'callback', inMinutes: 60, line: { en: "We'll call you back. Goodbye." } },
      ],
    },
    targets: [
      {
        key: 'support',
        description: 'Problems with an existing account',
        label: { en: 'our support team', hi: 'सपोर्ट टीम' },
        destination: { kind: 'pool', poolId: POOL_SUPPORT },
        from: [{ kind: 'pool', poolId: POOL_SALES }],
        hold: {
          steps: [{ kind: 'silence', seconds: 3 }],
          onTimeout: [{ kind: 'return' }, { kind: 'default' }],
        },
      },
      {
        key: 'another_language',
        description: 'The caller wants another language',
        destination: { kind: 'node', node: 'intent' },
      },
      {
        key: 'senior',
        description: 'The caller asks for a senior colleague',
        confirm: 'ask',
        destination: { kind: 'same-pool', skills: ['senior'] },
      },
      {
        key: 'billing',
        description: 'Payments and refunds',
        destination: { kind: 'agent', agent: { agentId: 'billing', release: { kind: 'latest' } } },
      },
    ],
  };
}

/** A schemaVersion 2 snapshot input: the R1 fixture plus `transferInput()`, pinned. */
export function transferSnapshotInput(): Record<string, any> {
  const input = snapshotInput();
  const transfer = transferInput();
  transfer.hold.steps[0].sha256 = MUSIC_SHA;
  transfer.targets[3].destination.agent.release = { kind: 'pinned', releaseId: BILLING_RELEASE };
  return {
    ...input,
    schemaVersion: 2,
    transfer,
    releaseIds: [...input.releaseIds, BILLING_RELEASE],
  };
}

export { POOL_SALES, POOL_SUPPORT, SUPPORT_RELEASE };
