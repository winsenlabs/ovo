import { exampleRoutingSnapshot, EXAMPLE_IDS as I } from '@winsendotai/ovo-plugin-router/testing';
import type { RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';

/** The managed queue the worked example binds as `desk`. */
export const DESK_QUEUE_ID = '00000000-0000-4000-8000-0000000000e1';

const pinned = (agentId: string, releaseId: string) => ({
  agentId,
  release: { kind: 'pinned', releaseId },
});
const keypad = (digits: string) => ({ kind: 'dtmf', digits });
const OFFICE_HOURS = {
  timezone: 'Asia/Kolkata',
  weekly: Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri'].map((day) => [day, [{ start: '09:00', end: '18:00' }]]),
  ),
};

/**
 * The release the committed worked-example corpus runs on (`snapshot.json` is this, written out; a
 * test regenerates it, so the file cannot drift). It is `docs/architecture/routing.md`'s worked
 * example, the R1 router fixtures' release, with what the R2 and R3 sections add: a managed queue
 * `desk` bound to the point and open in Kolkata office hours, a transfer policy that waits for
 * capacity, a person / callback / opt-out branch, a `billing` node on an external webhook then the
 * decision engine, and tight limits (three router turns) so a slow route reaches the release default.
 */
export function workedExampleSnapshot(): RoutingReleaseSnapshot {
  return exampleRoutingSnapshot((raw) => {
    raw.schemaVersion = 3;
    raw.limits = { maxTurns: 3, maxRouteSeconds: 90 };
    raw.transfer = {
      queueAnnouncement: { en: 'Everyone is busy. Please hold.' },
      hold: {
        steps: [{ kind: 'silence', seconds: 3 }],
        waitForCapacity: true,
        onTimeout: [{ kind: 'default' }],
      },
      targets: [
        {
          key: 'colleague',
          description: 'A human colleague',
          destination: { kind: 'human', queueId: 'desk' },
        },
      ],
    };
    raw.humanQueues = [{ key: 'desk', queueId: DESK_QUEUE_ID, priority: 0 }];
    raw.queues = {
      [DESK_QUEUE_ID]: {
        id: DESK_QUEUE_ID,
        version: 1,
        key: 'desk',
        priority: 0,
        definition: {
          kind: 'managed',
          name: 'Desk',
          announcement: { en: 'A colleague will take over.' },
          hours: OFFICE_HOURS,
        },
      },
    };
    const [intent, product] = raw.nodes;
    intent.engines[0].rules = [
      { branch: 'person', when: [{ kind: 'caller-id', prefixes: ['+919876'] }] },
      { branch: 'sales', when: [keypad('1')] },
      { branch: 'support', when: [keypad('2')] },
      { branch: 'billing', when: [keypad('3')] },
      { branch: 'person', when: [keypad('0')] },
      { branch: 'quit', when: [keypad('9')] },
      {
        branch: 'callback',
        when: [{ kind: 'keywords', words: ['callback', 'call back', 'call me back'], maxWords: 6 }],
      },
    ];
    intent.branches.push(
      { key: 'billing', description: 'Asks about an invoice or a refund', next: 'billing' },
      {
        key: 'person',
        description: 'Wants to talk to a person',
        target: { kind: 'human', queueId: 'desk' },
      },
      {
        key: 'callback',
        description: 'Asks to be called back later',
        target: {
          kind: 'callback',
          inMinutes: 60,
          line: { en: 'We will call you back within the hour.' },
        },
      },
      {
        key: 'quit',
        description: 'Does not want to continue',
        target: {
          kind: 'end',
          line: { en: 'No problem. Goodbye.' },
          disposition: 'caller_declined',
        },
      },
    );
    intent.fallback = [
      { kind: 'reask', times: 2 },
      { kind: 'human', queueId: 'desk' },
      { kind: 'default' },
      intent.fallback.at(-1),
    ];
    product.engines[1].generatedClarify = true;
    raw.nodes.push({
      id: 'billing',
      sets: 'billing',
      ask: { en: 'Is it about an invoice or a refund?' },
      reuseTurn: false,
      engines: [
        {
          kind: 'external',
          endpoint: 'https://decide.example.com/billing',
          credentialId: 'billing-router',
        },
        {
          kind: 'decision',
          instructions: 'Is the caller asking about an invoice or about a refund?',
        },
      ],
      branches: [
        {
          key: 'invoice',
          description: 'A question about an invoice or a bill',
          target: { kind: 'agent', agent: pinned('support-cards', I.supportCards) },
        },
        {
          key: 'refund',
          description: 'Wants money back',
          target: { kind: 'agent', agent: pinned('support-loans', I.supportLoans) },
        },
      ],
      fallback: [
        { kind: 'reask', times: 1 },
        { kind: 'default', target: { kind: 'pool', poolId: I.salesPool, language: 'any' } },
      ],
    });
  });
}
