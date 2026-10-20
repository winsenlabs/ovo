import type { HumanQueueContext, QueueContextPolicy } from '@winsendotai/ovo-contracts';

/** The one fake caller every test and preview uses (a reserved 555-01xx number). */
export const SYNTHETIC_CALLER = '+15550100';
const SYNTHETIC_CALLED = '+15550199';

/**
 * A made-up call for `preview` and `test-webhook`: only the namespaces the queue's context policy
 * turns on are present, exactly as on a real call, so a mapping that reads a switched-off field
 * renders empty here too. It carries `test: true`; nothing in it is, or comes from, a real call.
 */
export function syntheticContext(input: {
  policy: QueueContextPolicy;
  queue: { key: string; id: string; name: string };
  callbackBaseUrl: string;
  now: Date;
}): HumanQueueContext {
  const { policy, queue } = input;
  const startedAt = new Date(input.now.getTime() - 45_000).toISOString();
  const said = [
    { role: 'caller' as const, text: 'I was charged twice for the same bill.' },
    { role: 'agent' as const, text: 'I can connect you to a colleague who can look at that.' },
  ];
  // `slice(-0)` is the whole array, so the count is taken from the front.
  const turns = said.slice(
    said.length - Math.max(0, Math.min(said.length, policy.transcriptTurns)),
  );
  const variables = Array.isArray(policy.variables)
    ? Object.fromEntries(policy.variables.map((name) => [name, 'sample']))
    : { account_id: 'sample' };
  const base = `${input.callbackBaseUrl.replace(/\/$/, '')}/api/v1/human-queue`;
  return {
    call: { id: 'call-test', direction: 'inbound', startedAt },
    ...(policy.callerId || policy.calledNumber
      ? {
          caller: {
            ...(policy.callerId ? { number: SYNTHETIC_CALLER } : {}),
            ...(policy.calledNumber ? { calledNumber: SYNTHETIC_CALLED } : {}),
          },
        }
      : {}),
    ...(policy.language || policy.intent
      ? {
          route: {
            ...(policy.language ? { language: 'en' } : {}),
            ...(policy.intent ? { intent: 'billing', path: ['intent', 'billing'] } : {}),
          },
        }
      : {}),
    handover: {
      ...(policy.summary
        ? { summary: 'Caller was charged twice and wants a refund.', reason: 'wants a person' }
        : {}),
      ...(turns.length ? { transcript: turns } : {}),
    },
    ...(Object.keys(variables).length ? { variables } : {}),
    queue,
    ticket: {
      id: 'ticket-test',
      idempotencyKey: 'hq:test:call-test:1',
      priority: 0,
      callbackUrl: `${base}/callbacks/ticket-test`,
      ...(policy.transcriptLink
        ? {
            contextUrl: `${base}/context/ticket-test?t=test`,
            transcriptUrl: `${base}/context/ticket-test?t=test`,
          }
        : {}),
      expiresAt: new Date(input.now.getTime() + 180_000).toISOString(),
    },
    time: { now: input.now.toISOString() },
    test: true,
  };
}
