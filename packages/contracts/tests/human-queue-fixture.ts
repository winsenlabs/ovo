import { HumanQueueDefinition, RoutingPointDraft, RoutingReleaseSnapshot } from '../src/index.ts';
import { draftInput, snapshotInput } from './routing-fixture.ts';
import { transferInput } from './transfer-fixture.ts';

export const QUEUE_EXT = 'abcdef01-0000-4000-8000-000000000001';
export const QUEUE_MAN = 'abcdef01-0000-4000-8000-000000000002';

/** The design's worked external queue (section 10.2). */
export function externalQueueInput(): Record<string, any> {
  return {
    kind: 'external',
    name: 'Acme ACD',
    hours: {
      timezone: 'Asia/Kolkata',
      weekly: { mon: [{ start: '09:00', end: '21:00' }] },
      closed: [],
    },
    announcement: { en: "I'm connecting you to a colleague. Please hold." },
    hold: {
      steps: [
        { kind: 'silence', seconds: 3 },
        { kind: 'line', line: { en: 'Thanks for holding.' } },
      ],
      loopFrom: 0,
      maxSeconds: 180,
      onTimeout: [
        { kind: 'return' },
        { kind: 'callback', inMinutes: 60, line: { en: 'We will call you back. Goodbye.' } },
        { kind: 'end', line: { en: 'Goodbye.' } },
      ],
    },
    webhook: {
      url: 'https://acd.example.com/ovo/handoff',
      credentialId: 'acd-hmac',
      auth: { kind: 'header', name: 'X-Api-Key', credentialId: 'acd-key' },
      body: {
        callId: { $from: 'call.id' },
        ani: { $from: 'caller.number', default: '' },
        lang: { $from: 'route.language', default: 'en' },
        notes: { $template: 'Intent {{route.intent}}: {{handover.summary}}', maxChars: 500 },
        account: { $from: 'variables.account_id' },
        replyTo: { $from: 'ticket.callbackUrl' },
        ref: { $from: 'ticket.idempotencyKey' },
      },
      response: {
        statusPath: '/result',
        acceptedValues: ['ok'],
        destinationE164Path: '/dial/number',
        destinationSipUriPath: '/dial/uri',
      },
      retry: { attempts: 3, baseMs: 500, maxMs: 5000, deadlineMs: 15000 },
    },
    destination: {
      allowE164Prefixes: ['+9140', '+91801'],
      allowSipHosts: ['.acd.example.com'],
      allowedHeaders: ['X-Acd-Ticket'],
    },
    context: {
      callerId: true,
      calledNumber: false,
      language: true,
      intent: true,
      summary: true,
      transcriptTurns: 4,
      transcriptLink: true,
      variables: ['account_id'],
      summarize: 'agent_only',
    },
  };
}

export function managedQueueInput(): Record<string, any> {
  return {
    kind: 'managed',
    name: 'Floor',
    assignment: 'AUTO_ASSIGN',
    teamIds: ['support'],
    returnTargets: ['support', 'billing'],
    returnDefault: 'support',
    wrapUp: { required: true, dispositions: ['resolved', 'escalated'] },
  };
}

export const externalQueue = () => HumanQueueDefinition.parse(externalQueueInput());
export const managedQueue = () => HumanQueueDefinition.parse(managedQueueInput());

/** The R1 fixture draft plus a `human` fallback step, branch target and transfer target bound to two queues. */
export function queueDraftInput(): Record<string, any> {
  const input: Record<string, any> = draftInput();
  input.humanQueues = [
    { key: 'support-desk', queueId: QUEUE_EXT, priority: 1 },
    { key: 'floor', queueId: QUEUE_MAN },
  ];
  const node = input.nodes[0];
  node.branches.push({
    key: 'person',
    description: 'Wants to speak to a person',
    target: { kind: 'human', queueId: 'floor' },
  });
  node.fallback.splice(1, 0, { kind: 'human', queueId: 'support-desk' });
  input.transfer = transferInput();
  input.transfer.targets.push({
    key: 'colleague',
    description: 'A human colleague',
    destination: { kind: 'human', queueId: 'support-desk' },
  });
  return input;
}

export const queueDraft = (patch: (input: Record<string, any>) => void = () => {}) => {
  const input = queueDraftInput();
  patch(input);
  return RoutingPointDraft.parse(input);
};

/** A schemaVersion 3 snapshot input: the draft with its queues pinned. */
export function queueSnapshotInput(): Record<string, any> {
  const input: Record<string, any> = snapshotInput();
  const draft = queueDraftInput();
  const transfer = draft.transfer;
  transfer.hold.steps[0].sha256 = 'a'.repeat(64);
  transfer.targets[3].destination.agent.release = {
    kind: 'pinned',
    releaseId: '99999999-9999-4999-8999-999999999999',
  };
  const managed = managedQueue();
  return {
    ...input,
    ...draft,
    nodes: draft.nodes,
    schemaVersion: 3,
    router: input.router,
    defaultTarget: input.defaultTarget,
    pools: input.pools,
    releaseIds: [...input.releaseIds, '99999999-9999-4999-8999-999999999999'],
    queues: {
      [QUEUE_EXT]: {
        id: QUEUE_EXT,
        version: 2,
        key: 'support-desk',
        priority: 1,
        definition: externalQueue(),
      },
      [QUEUE_MAN]: { id: QUEUE_MAN, version: 1, key: 'floor', priority: 0, definition: managed },
    },
  };
}

export const queueSnapshot = () => RoutingReleaseSnapshot.parse(queueSnapshotInput());
