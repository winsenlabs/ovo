import type {
  HumanQueueDefinition,
  QueueContextPolicy,
  TicketContext,
} from '@winsendotai/ovo-contracts';
import { EXTERNAL_CONTEXT_DEFAULT } from '@winsendotai/ovo-contracts';

/** The policy a third party's context link applies: the queue's own, else the strictest default. */
export function policyOf(definition: HumanQueueDefinition | undefined): QueueContextPolicy {
  return definition?.context ?? EXTERNAL_CONTEXT_DEFAULT;
}

/**
 * The ticket context a third party may read (design 6.3): whatever the queue's policy lets
 * through and nothing else, applied again here on top of what the worker stored, so a policy
 * tightened since the ticket was made takes effect for the link too. Send-back targets and the
 * transferring agent are internal and never leave. `variables: 'declared'` is for the desk only; a
 * webhook queue that somehow carries it reads as an empty allow-list.
 */
export function externalContext(context: TicketContext, policy: QueueContextPolicy): TicketContext {
  const allowed = Array.isArray(policy.variables) ? new Set(policy.variables) : new Set<string>();
  return {
    callId: context.callId,
    brief: context.brief,
    ...(policy.summary && context.summary ? { summary: context.summary } : {}),
    ...(policy.summary && context.reason ? { reason: context.reason } : {}),
    ...(policy.language && context.language ? { language: context.language } : {}),
    ...(policy.intent && context.intent ? { intent: context.intent } : {}),
    routePath: policy.intent ? context.routePath : [],
    caller: {
      ...(policy.callerId && context.caller.number ? { number: context.caller.number } : {}),
      ...(policy.calledNumber && context.caller.calledNumber
        ? { calledNumber: context.caller.calledNumber }
        : {}),
    },
    transcript: policy.transcriptTurns > 0 ? context.transcript.slice(-policy.transcriptTurns) : [],
    variables: Object.fromEntries(
      Object.entries(context.variables).filter(([name]) => allowed.has(name)),
    ),
    returnTargets: [],
  };
}
