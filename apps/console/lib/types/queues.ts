/**
 * The queue administration wire shapes (Wave 17 design 4.1, 4.2 and 6.1): a queue definition as
 * the form edits it, and what the preview, test and operator routes answer. The API validates
 * every field; these types only keep the form honest about which keys exist.
 */
export type Lines = Record<string, string>;

export interface HoursWindow {
  start: string;
  end: string;
}
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export interface QueueHours {
  timezone: string;
  weekly: Partial<Record<Weekday, HoursWindow[]>>;
  closed: string[];
}

export type HoldStep =
  | { kind: 'clip'; assetId: string; maxSeconds?: number }
  | { kind: 'silence'; seconds: number }
  | { kind: 'line'; line: Lines };
export type HoldTimeoutStep =
  | { kind: 'target'; key: string }
  | { kind: 'default' }
  | { kind: 'return' }
  | { kind: 'human'; queueId: string }
  | { kind: 'callback'; inMinutes: number; line: Lines }
  | { kind: 'end'; line: Lines };
export interface HoldPolicy {
  steps: HoldStep[];
  loopFrom: number;
  maxSeconds: number;
  waitForCapacity: boolean;
  onTimeout: HoldTimeoutStep[];
}

export interface ContextPolicy {
  callerId: boolean;
  calledNumber: boolean;
  language: boolean;
  intent: boolean;
  summary: boolean;
  transcriptTurns: number;
  transcriptLink: boolean;
  variables: 'declared' | string[];
  summarize: 'agent_only' | 'generate';
}

export interface DestinationPolicy {
  allowE164Prefixes: string[];
  allowSipHosts: string[];
  allowInsecureSip: boolean;
  allowedHeaders: string[];
}

export interface WebhookResponseMapping {
  statusPath?: string;
  acceptedValues: string[];
  queuedValues: string[];
  rejectedValues: string[];
  ticketRefPath?: string;
  destinationE164Path?: string;
  destinationSipUriPath?: string;
  destinationHeadersPath?: string;
}

export type WebhookAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; credentialId: string }
  | { kind: 'header'; name: string; credentialId: string };

export interface WebhookSpec {
  url: string;
  method: 'POST' | 'PUT';
  format: 'json' | 'form';
  credentialId: string;
  auth: WebhookAuth;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  timeoutMs: number;
  retry: { attempts: number; baseMs: number; maxMs: number; deadlineMs: number };
  response: WebhookResponseMapping;
  cancel: boolean;
}

interface QueueBase {
  name: string;
  description?: string;
  hours?: QueueHours;
  announcement?: Lines;
  hold?: HoldPolicy;
  limits: { maxWaiting: number };
  context: ContextPolicy;
}

export interface ExternalQueueDefinition extends QueueBase {
  kind: 'external';
  webhook: WebhookSpec;
  destination: DestinationPolicy;
  callbackWindowHours: number;
}

export interface ManagedQueueDefinition extends QueueBase {
  kind: 'managed';
  assignment: 'AUTO_ASSIGN' | 'OPEN_PICKUP';
  teamIds: string[];
  language: 'ignore' | 'prefer' | 'require';
  offerSeconds: number;
  joinSeconds: number;
  requireOnline: boolean;
  ai: { mode: 'out' | 'transcribe'; transcribeOperator: boolean };
  onOperatorLeave: 'end_call' | 'return_to_agent';
  returnTargets: string[];
  returnDefault?: string;
  wrapUp: { required: boolean; dispositions: string[] };
}

export type QueueDefinition = ExternalQueueDefinition | ManagedQueueDefinition;

export interface QueueStats {
  waiting: number;
  offered: number;
  oldestWaitMs: number;
  online: number;
  handled24h: number;
}

/** A row of `GET /v1/human-queues`: the definition with its live numbers. */
export interface QueueRecord {
  id: string;
  version: number;
  definition: QueueDefinition;
  stats: QueueStats;
  usedBy: string[];
  updatedAt: string;
}

export interface QueueIssue {
  path: (string | number)[];
  code?: string;
  message: string;
}

export interface PreviewResult {
  body?: unknown;
  issues: QueueIssue[];
}

export interface WebhookTestAttempt {
  attempt: number;
  outcome: string;
  status?: number;
  ms: number;
  reason?: string;
}
export interface WebhookTestResult {
  request: { url: string; headers: Record<string, string>; body: unknown };
  attempts: WebhookTestAttempt[];
  /** Why delivery failed (`timeout`, `transport`, `http_503`...), when it did. */
  failure?: string;
  answer?: {
    kind: string;
    reason?: string;
    destination?: Record<string, unknown>;
    /** Whether the destination the third party named is inside the queue's allow-list. */
    destinationCheck?: 'allowed' | 'refused';
  };
}

export interface OperatorRow {
  userId: string;
  label?: string;
  email?: string;
  userDisabled?: boolean;
  displayName: string;
  enabled: boolean;
  teamIds: string[];
  languages: string[];
  capacity: number;
  status: 'AVAILABLE' | 'AWAY' | 'OFFLINE';
  lastSeenAt?: string;
  active: number;
}

export type ActivityWindow = '24h' | '7d';
export interface QueueActivity {
  queueId: string;
  window: ActivityWindow;
  stats: {
    created: number;
    handled: number;
    abandoned: number;
    expired: number;
    webhookFailed: number;
    avgWaitMs: number | null;
    p95WaitMs: number | null;
    avgTalkMs: number | null;
    byOutcome: Record<string, number>;
  };
  /** Newest 50. Ids and codes only: never a number, a summary or caller context. */
  tickets: {
    id: string;
    callId: string;
    status: string;
    priority: number;
    language?: string;
    createdAt: string;
    waitMs: number;
    releasedAt?: string;
    releaseCode?: string;
    outcome?: string;
    operatorId?: string;
  }[];
}
