import type {
  ContextPolicy,
  ExternalQueueDefinition,
  HoldPolicy,
  ManagedQueueDefinition,
  QueueDefinition,
  QueueIssue,
  QueueRecord,
} from '../types/queues';

/** The same defaults the contracts apply, so a new queue starts valid and the API fills nothing. */
export const EXTERNAL_CONTEXT: ContextPolicy = {
  callerId: false,
  calledNumber: false,
  language: true,
  intent: true,
  summary: true,
  transcriptTurns: 0,
  transcriptLink: true,
  variables: [],
  summarize: 'agent_only',
};
export const MANAGED_CONTEXT: ContextPolicy = {
  callerId: true,
  calledNumber: true,
  language: true,
  intent: true,
  summary: true,
  transcriptTurns: 6,
  transcriptLink: false,
  variables: 'declared',
  summarize: 'agent_only',
};

export const DEFAULT_HOLD: HoldPolicy = {
  steps: [{ kind: 'silence', seconds: 2 }],
  loopFrom: 0,
  maxSeconds: 180,
  waitForCapacity: false,
  onTimeout: [{ kind: 'return' }, { kind: 'default' }, { kind: 'end', line: { en: 'Goodbye.' } }],
};

export function blankQueue(kind: QueueDefinition['kind']): QueueDefinition {
  const base = { name: '', limits: { maxWaiting: 100 } };
  if (kind === 'external')
    return {
      ...base,
      kind,
      webhook: {
        url: '',
        method: 'POST',
        format: 'json',
        credentialId: '',
        auth: { kind: 'none' },
        headers: {},
        timeoutMs: 3_000,
        retry: { attempts: 3, baseMs: 500, maxMs: 5_000, deadlineMs: 15_000 },
        response: {
          acceptedValues: ['accepted', 'ok', 'connected'],
          queuedValues: ['queued', 'pending', 'waiting'],
          rejectedValues: ['rejected', 'denied', 'closed', 'unavailable'],
        },
        cancel: true,
      },
      destination: {
        allowE164Prefixes: [],
        allowSipHosts: [],
        allowInsecureSip: false,
        allowedHeaders: [],
      },
      context: EXTERNAL_CONTEXT,
      callbackWindowHours: 24,
    } satisfies ExternalQueueDefinition;
  return {
    ...base,
    kind,
    assignment: 'OPEN_PICKUP',
    teamIds: [],
    language: 'prefer',
    offerSeconds: 20,
    joinSeconds: 25,
    requireOnline: true,
    ai: { mode: 'transcribe', transcribeOperator: true },
    onOperatorLeave: 'end_call',
    returnTargets: [],
    wrapUp: { required: false, dispositions: [] },
    context: MANAGED_CONTEXT,
  } satisfies ManagedQueueDefinition;
}

/** Fields the mapping editor offers, by what the context policy lets through. */
export const CONTEXT_FIELDS: readonly { path: string; label: string; policy?: keyof ContextPolicy }[] = [
  { path: 'call.id', label: 'Call id' },
  { path: 'call.direction', label: 'Call direction' },
  { path: 'call.startedAt', label: 'Call start time' },
  { path: 'caller.number', label: 'Caller number', policy: 'callerId' },
  { path: 'caller.calledNumber', label: 'Dialled number', policy: 'calledNumber' },
  { path: 'route.language', label: 'Language', policy: 'language' },
  { path: 'route.intent', label: 'Intent', policy: 'intent' },
  { path: 'handover.summary', label: 'Agent summary', policy: 'summary' },
  { path: 'handover.reason', label: 'Transfer reason', policy: 'summary' },
  { path: 'queue.key', label: 'Queue key' },
  { path: 'queue.name', label: 'Queue name' },
  { path: 'ticket.id', label: 'Ticket id' },
  { path: 'ticket.idempotencyKey', label: 'Idempotency key' },
  { path: 'ticket.callbackUrl', label: 'Callback URL' },
  { path: 'ticket.contextUrl', label: 'Context link', policy: 'transcriptLink' },
  { path: 'ticket.transcriptUrl', label: 'Transcript link', policy: 'transcriptLink' },
  { path: 'time.now', label: 'Current time' },
];

/** The picker only lists fields the policy can supply; the rest would render empty. */
export function availableContextFields(policy: ContextPolicy) {
  return CONTEXT_FIELDS.filter((field) => !field.policy || Boolean(policy[field.policy]));
}

export interface QueueKpis {
  queues: number;
  waiting: number;
  online: number;
}

export function queueKpis(records: readonly QueueRecord[]): QueueKpis {
  return {
    queues: records.length,
    waiting: records.reduce((sum, row) => sum + row.stats.waiting + row.stats.offered, 0),
    online: records.reduce((sum, row) => Math.max(sum, row.stats.online), 0),
  };
}

export function kindLabel(kind: QueueDefinition['kind']): string {
  return kind === 'external' ? 'Webhook' : 'Operator desk';
}

/** "Mon–Fri 09:00–21:00 IST"-style one-liner for the table; "Always open" when unset. */
export function hoursSummary(hours: QueueDefinition['hours']): string {
  if (!hours) return 'Always open';
  const days = Object.entries(hours.weekly).filter(([, windows]) => windows && windows.length > 0);
  if (!days.length) return 'Closed';
  const first = days[0]![1]![0]!;
  return `${days.length} day${days.length === 1 ? '' : 's'}, ${first.start}–${first.end} ${hours.timezone}`;
}

/** Strings a mapping or header may not use as a key, mirrored client-side for instant feedback. */
export function isReservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('x-ovo-') ||
    ['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'authorization', 'cookie', 'idempotency-key', 'user-agent'].includes(lower)
  );
}

/** A copy of `value` with `path` ("webhook.retry.attempts") set; creates objects on the way. */
export function setIn<T extends object>(value: T, path: string, next: unknown): T {
  const [head, ...rest] = path.split('.');
  const copy = { ...value } as Record<string, unknown>;
  copy[head!] = rest.length
    ? setIn((copy[head!] as object | undefined) ?? {}, rest.join('.'), next)
    : next;
  return copy as T;
}

/** The message of the first validation issue at or under `path` ("webhook.url"), if any. */
export function issueAt(issues: readonly QueueIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path.join('.') === path)?.message;
}

/** Issues no field claimed, shown once above the form so none is silently dropped. */
export function unclaimedIssues(issues: readonly QueueIssue[], claimed: readonly string[]) {
  return issues.filter(
    (issue) => !claimed.some((prefix) => issue.path.join('.').startsWith(prefix)),
  );
}
