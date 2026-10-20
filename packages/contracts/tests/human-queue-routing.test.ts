import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUEUE_HOLD_POLICY,
  effectiveQueueHold,
  HumanQueueDefinition,
  queueDefinitionIssues,
  queueHoldSource,
  queueKeyRefs,
  RoutingPointDraft,
  RoutingReleaseSnapshot,
  routingDraftIssues,
  routingQueueIds,
  routingVoiceLines,
  TRANSFER_BUILT_IN_LINES,
  TransferDestination,
  type RoutingIssue,
} from '../src/index.ts';
import {
  externalQueue,
  externalQueueInput,
  managedQueue,
  managedQueueInput,
  QUEUE_EXT,
  QUEUE_MAN,
  queueDraft,
  queueDraftInput,
  queueSnapshot,
  queueSnapshotInput,
} from './human-queue-fixture.ts';
import { draft, draftInput, ROUTER_RELEASE, SALES_EN_RELEASE } from './routing-fixture.ts';
import { transferSnapshotInput } from './transfer-fixture.ts';

const only = (issues: RoutingIssue[], code: string) => issues.filter((i) => i.code === code);

describe('a point that binds human queues', () => {
  it('parses humanQueues, a human transfer destination and finds nothing structurally wrong', () => {
    const parsed = queueDraft();
    expect(parsed.humanQueues).toEqual([
      { key: 'support-desk', queueId: QUEUE_EXT, priority: 1 },
      { key: 'floor', queueId: QUEUE_MAN, priority: 0 },
    ]);
    expect(routingDraftIssues(parsed)).toEqual([]);
    expect(routingQueueIds(parsed)).toEqual([QUEUE_EXT, QUEUE_MAN]);
    expect(TransferDestination.parse({ kind: 'human', queueId: 'support-desk' })).toEqual({
      kind: 'human',
      queueId: 'support-desk',
    });
  });

  it('lists the queue keys a draft names, with paths', () => {
    expect(queueKeyRefs(queueDraft())).toEqual([
      { path: ['nodes', 0, 'branches', 2, 'target', 'queueId'], key: 'floor' },
      { path: ['nodes', 0, 'fallback', 1, 'queueId'], key: 'support-desk' },
      { path: ['transfer', 'targets', 4, 'destination', 'queueId'], key: 'support-desk' },
    ]);
  });

  it('keeps R1 and R2 drafts exactly as they were', () => {
    expect(RoutingPointDraft.parse(draftInput()).humanQueues).toBeUndefined();
    expect(routingQueueIds(draft())).toEqual([]);
    const withHuman = draft((d) =>
      d.nodes[0].fallback.splice(1, 0, { kind: 'human', queueId: 'q' }),
    );
    expect(routingDraftIssues(withHuman)).toEqual([
      expect.objectContaining({ code: 'routing_human_unavailable', severity: 'warning' }),
    ]);
  });

  it('drops the R1/R2 human warnings once queues are bound, and keeps them without', () => {
    const issues = routingDraftIssues(queueDraft());
    expect(only(issues, 'routing_human_unavailable')).toEqual([]);
    expect(only(issues, 'routing_transfer_human_unavailable')).toEqual([]);
    const timeout = queueDraft((d) =>
      d.transfer.hold.onTimeout.splice(0, 0, { kind: 'human', queueId: 'floor' }),
    );
    expect(routingDraftIssues(timeout)).toEqual([]);
    const noQueues = draft((d) => {
      d.transfer = {
        hold: {
          steps: [{ kind: 'silence', seconds: 1 }],
          onTimeout: [
            { kind: 'human', queueId: 'q' },
            { kind: 'end', line: { en: 'Bye' } },
          ],
        },
      };
    });
    expect(only(routingDraftIssues(noQueues), 'routing_transfer_human_unavailable')).toHaveLength(
      1,
    );
  });

  it('routing_queue_unknown: a human key no binding names', () => {
    const issues = routingDraftIssues(
      queueDraft((d) => {
        d.nodes[0].fallback[1] = { kind: 'human', queueId: 'ghost' };
        d.nodes[0].branches[2].target = { kind: 'human', queueId: 'phantom' };
        d.transfer.targets[4].destination.queueId = 'spectre';
        d.transfer.hold.onTimeout.splice(0, 0, { kind: 'human', queueId: 'wraith' });
      }),
    );
    expect(only(issues, 'routing_queue_unknown').map((i) => [i.severity, i.path])).toEqual([
      ['error', ['nodes', 0, 'branches', 2, 'target', 'queueId']],
      ['error', ['nodes', 0, 'fallback', 1, 'queueId']],
      ['error', ['transfer', 'targets', 4, 'destination', 'queueId']],
      ['error', ['transfer', 'hold', 'onTimeout', 0, 'queueId']],
    ]);
  });

  it('routing_queue_key_duplicate: a key or a queue bound twice', () => {
    const issues = routingDraftIssues(
      queueDraft((d) => {
        d.humanQueues.push({ key: 'floor', queueId: QUEUE_EXT });
        d.humanQueues.push({ key: 'other', queueId: QUEUE_MAN });
      }),
    );
    expect(only(issues, 'routing_queue_key_duplicate').map((i) => i.path)).toEqual([
      ['humanQueues', 2, 'key'],
      ['humanQueues', 2, 'queueId'],
      ['humanQueues', 3, 'queueId'],
    ]);
  });

  it('routing_queue_unused: a binding nothing names is a warning', () => {
    const issues = routingDraftIssues(
      queueDraft((d) => {
        d.nodes[0].branches.pop();
      }),
    );
    expect(only(issues, 'routing_queue_unused')).toEqual([
      expect.objectContaining({ severity: 'warning', path: ['humanQueues', 1] }),
    ]);
  });

  it('routing_queue_chain_loop: a timeout chain naming a queue twice, or its own target queue', () => {
    const twice = routingDraftIssues(
      queueDraft((d) => {
        d.transfer.hold.onTimeout.splice(
          0,
          0,
          { kind: 'human', queueId: 'floor' },
          { kind: 'human', queueId: 'floor' },
        );
      }),
    );
    expect(only(twice, 'routing_queue_chain_loop').map((i) => i.path)).toEqual([
      ['transfer', 'hold', 'onTimeout', 1, 'queueId'],
    ]);
    const own = routingDraftIssues(
      queueDraft((d) => {
        d.transfer.targets[4].hold = {
          steps: [{ kind: 'silence', seconds: 1 }],
          onTimeout: [{ kind: 'human', queueId: 'support-desk' }, { kind: 'default' }],
        };
      }),
    );
    expect(only(own, 'routing_queue_chain_loop')).toHaveLength(1);
    const fine = routingDraftIssues(
      queueDraft((d) => {
        d.transfer.targets[4].hold = {
          steps: [{ kind: 'silence', seconds: 1 }],
          onTimeout: [{ kind: 'human', queueId: 'floor' }, { kind: 'default' }],
        };
      }),
    );
    expect(only(fine, 'routing_queue_chain_loop')).toEqual([]);
  });

  it('routing_queue_limits_exceeded: more than ten queues cannot be parsed; the check covers a raw object', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      key: `q${i}`,
      queueId: `abcdef01-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
      priority: 0,
    }));
    expect(RoutingPointDraft.safeParse({ ...queueDraftInput(), humanQueues: many }).success).toBe(
      false,
    );
    const raw = { ...queueDraft(), humanQueues: many };
    expect(only(routingDraftIssues(raw), 'routing_queue_limits_exceeded')).toHaveLength(1);
  });
});

describe('queue definitions against the point', () => {
  const issues = (queue: Record<string, any>, transfer: 'point' | 'none' = 'point') => {
    const out: RoutingIssue[] = [];
    queueDefinitionIssues(
      { key: 'floor', definition: HumanQueueDefinition.parse(queue) },
      transfer === 'point' ? queueDraft().transfer : undefined,
      ['queues', QUEUE_MAN],
      (code, path, message, severity = 'error') => out.push({ code, severity, path, message }),
    );
    return out;
  };

  it('routing_queue_return_target_unknown: a return target or default the catalogue lacks', () => {
    expect(issues(managedQueueInput())).toEqual([]);
    const found = issues({
      ...managedQueueInput(),
      returnTargets: ['support', 'nowhere'],
      returnDefault: 'gone',
    });
    expect(found.map((i) => i.path)).toEqual([
      ['queues', QUEUE_MAN, 'definition', 'returnTargets', 1],
      ['queues', QUEUE_MAN, 'definition', 'returnDefault'],
    ]);
    expect(issues(managedQueueInput(), 'none')).toHaveLength(3); // support, billing, default
  });

  it('checks a queue hold like any hold, and flags a queue that times out into itself', () => {
    const base = {
      ...managedQueueInput(),
      hold: {
        steps: [{ kind: 'silence', seconds: 2 }],
        loopFrom: 0,
        onTimeout: [{ kind: 'default' }],
      },
    };
    expect(issues(base)).toEqual([]);
    const code = (hold: Record<string, unknown>) =>
      issues({ ...base, hold: { ...base.hold, ...hold } }).map((i) => i.code);
    expect(code({ onTimeout: [{ kind: 'return' }] })).toEqual([
      'routing_transfer_timeout_not_terminal',
    ]);
    expect(code({ loopFrom: 3 })).toEqual(['routing_transfer_hold_loop_invalid']);
    expect(code({ onTimeout: [{ kind: 'human', queueId: 'floor' }, { kind: 'default' }] })).toEqual(
      ['routing_queue_chain_loop'],
    );
    expect(code({ onTimeout: [{ kind: 'target', key: 'ghost' }, { kind: 'default' }] })).toEqual([
      'routing_transfer_timeout_target_unknown',
    ]);
    // A queue hold may return to the transferring agent and overflow into another queue without warnings.
    expect(
      code({
        onTimeout: [
          { kind: 'return' },
          { kind: 'human', queueId: 'support-desk' },
          { kind: 'default' },
        ],
      }),
    ).toEqual([]);
  });
});

describe('release snapshot schema 3', () => {
  it('pins queues by value under schemaVersion 3', () => {
    const snapshot = queueSnapshot();
    expect(snapshot.schemaVersion).toBe(3);
    expect(Object.keys(snapshot.queues)).toEqual([QUEUE_EXT, QUEUE_MAN]);
    expect(snapshot.queues[QUEUE_EXT]).toMatchObject({
      key: 'support-desk',
      version: 2,
      priority: 1,
    });
  });

  it('keeps R1 and R2 snapshots parsing, with an empty queues record', () => {
    const r2 = RoutingReleaseSnapshot.parse(transferSnapshotInput());
    expect(r2.schemaVersion).toBe(2);
    expect(r2.queues).toEqual({});
  });

  const messages = (input: Record<string, any>) =>
    RoutingReleaseSnapshot.safeParse(input).error?.issues.map((issue) => issue.message) ?? [];

  it('refuses the wrong schemaVersion for what the snapshot holds', () => {
    for (const schemaVersion of [1, 2])
      expect(messages({ ...queueSnapshotInput(), schemaVersion })).toContain(
        'A snapshot that binds human queues is schemaVersion 3',
      );
    expect(messages({ ...transferSnapshotInput(), schemaVersion: 3 })).toContain(
      'schemaVersion 3 is for snapshots that bind human queues',
    );
  });

  it('refuses a snapshot that does not hold every bound queue, or holds a stranger', () => {
    const missing = queueSnapshotInput();
    delete missing.queues[QUEUE_MAN];
    expect(messages(missing)).toContain('The snapshot holds every queue the draft binds');
    const stranger = queueSnapshotInput();
    const other = 'abcdef01-0000-4000-8000-000000000009';
    stranger.queues[other] = { ...stranger.queues[QUEUE_MAN], id: other };
    expect(messages(stranger)).toContain('The snapshot holds only queues the draft binds');
    const misKeyed = queueSnapshotInput();
    misKeyed.queues[QUEUE_MAN].id = QUEUE_EXT;
    expect(messages(misKeyed)).toContain('A queue snapshot is keyed by its id');
  });

  it('refuses a queue snapshot whose key or priority differs from its binding', () => {
    for (const patch of [{ key: 'renamed' }, { priority: 5 }]) {
      const input = queueSnapshotInput();
      input.queues[QUEUE_EXT] = { ...input.queues[QUEUE_EXT], ...patch };
      expect(messages(input)).toContain('A queue snapshot carries its binding key and priority');
    }
  });

  it('refuses a human key no binding names, with the code in the message', () => {
    const input = queueSnapshotInput();
    input.nodes[0].fallback[1] = { kind: 'human', queueId: 'ghost' };
    expect(messages(input).some((m) => m.startsWith('routing_queue_unknown'))).toBe(true);
  });

  it('refuses a managed queue whose return target is not in the catalogue', () => {
    const input = queueSnapshotInput();
    input.queues[QUEUE_MAN].definition = {
      ...input.queues[QUEUE_MAN].definition,
      returnTargets: ['ghost'],
    };
    expect(messages(input).some((m) => m.startsWith('routing_queue_return_target_unknown'))).toBe(
      true,
    );
  });
});

describe('effectiveQueueHold', () => {
  it('prefers the queue hold, then the target hold, then the point hold, then the queue default', () => {
    const s = queueSnapshot();
    expect(effectiveQueueHold(s, 'support-desk')).toBe(s.queues[QUEUE_EXT]!.definition.hold);
    expect(queueHoldSource(s, 'support-desk')).toBe('queue');
    expect(effectiveQueueHold(s, 'floor')).toBe(s.transfer!.hold);
    expect(queueHoldSource(s, 'floor')).toBe('point');
    expect(effectiveQueueHold(s, 'floor', 'support')).toBe(s.transfer!.targets[0]!.hold);
    expect(queueHoldSource(s, 'floor', 'support')).toBe('target');
    expect(effectiveQueueHold(s, 'floor', 'billing')).toBe(s.transfer!.hold);
    const bare = { ...s, transfer: { ...s.transfer!, hold: undefined } };
    expect(effectiveQueueHold(bare, 'floor')).toBe(DEFAULT_QUEUE_HOLD_POLICY);
    expect(queueHoldSource(bare, 'floor')).toBe('default');
    expect(effectiveQueueHold({ queues: {} }, 'ghost')).toBe(DEFAULT_QUEUE_HOLD_POLICY);
    expect(effectiveQueueHold({}, 'ghost')).toBe(DEFAULT_QUEUE_HOLD_POLICY);
  });

  it('has a default of silence, a looped hold line and a chain that ends the call', () => {
    expect(DEFAULT_QUEUE_HOLD_POLICY).toMatchObject({
      maxSeconds: 180,
      loopFrom: 0,
      waitForCapacity: false,
    });
    expect(DEFAULT_QUEUE_HOLD_POLICY.steps[0]).toEqual({ kind: 'silence', seconds: 2 });
    expect(DEFAULT_QUEUE_HOLD_POLICY.steps[1]).toMatchObject({ kind: 'line' });
    expect(DEFAULT_QUEUE_HOLD_POLICY.onTimeout.map((s) => s.kind)).toEqual([
      'return',
      'default',
      'end',
    ]);
    expect(TRANSFER_BUILT_IN_LINES.human.en).toBe(
      "I'm connecting you to a colleague. Please hold.",
    );
    expect(Object.keys(TRANSFER_BUILT_IN_LINES.human)).toEqual(['en', 'hi']);
    expect(Object.keys(TRANSFER_BUILT_IN_LINES.callback)).toEqual(['en', 'hi']);
  });
});

describe('voice lines for human queues', () => {
  it('leaves a release without queues exactly as R2 left it', () => {
    const router = routingVoiceLines(RoutingReleaseSnapshot.parse(transferSnapshotInput())).get(
      ROUTER_RELEASE,
    )!;
    expect(router).not.toContain(TRANSFER_BUILT_IN_LINES.human.en);
    expect(router).not.toContain(TRANSFER_BUILT_IN_LINES.callback.en);
  });

  it('gives the router each queue announcement, its hold and timeout lines, and the human built-ins', () => {
    const router = routingVoiceLines(queueSnapshot()).get(ROUTER_RELEASE)!;
    expect(router).toEqual(
      expect.arrayContaining([
        "I'm connecting you to a colleague. Please hold.",
        'Thanks for holding.',
        'We will call you back. Goodbye.',
        'Goodbye.',
        TRANSFER_BUILT_IN_LINES.callback.en,
      ]),
    );
  });

  it('adds a return target announcement in the house voice', () => {
    const input = queueSnapshotInput();
    input.transfer.targets[0].announcement = { en: 'Back to support, one moment.' };
    const router = routingVoiceLines(RoutingReleaseSnapshot.parse(input)).get(ROUTER_RELEASE)!;
    expect(router).toContain('Back to support, one moment.');
  });

  it('gives granted agents the announcement for a human catalogue target: target, queue, point, built-in', () => {
    const input = queueSnapshotInput();
    const sales = () =>
      routingVoiceLines(RoutingReleaseSnapshot.parse(input)).get(SALES_EN_RELEASE)!;
    input.queues[QUEUE_EXT].definition.announcement = { en: 'Putting you through to a person.' };
    expect(sales()).toContain('Putting you through to a person.');
    input.transfer.targets[4].announcement = { en: 'One moment, a colleague will join.' };
    expect(sales()).toContain('One moment, a colleague will join.');
    delete input.transfer.targets[4].announcement;
    delete input.queues[QUEUE_EXT].definition.announcement;
    expect(sales()).toContain(input.transfer.announcement.en);
    delete input.transfer.announcement;
    expect(sales()).toContain(TRANSFER_BUILT_IN_LINES.human.en);
    // The queue's own hold has a return step, so the built-in returned line is spoken too.
    expect(sales()).toContain(TRANSFER_BUILT_IN_LINES.returned.en);
  });

  it('only speaks languages the point allows', () => {
    const input = queueSnapshotInput();
    input.queues[QUEUE_EXT].definition.announcement = { en: 'English line.', fr: 'Ligne.' };
    const router = routingVoiceLines(RoutingReleaseSnapshot.parse(input)).get(ROUTER_RELEASE)!;
    expect(router).toContain('English line.');
    expect(router).not.toContain('Ligne.');
  });
});

describe('queue fixtures stay valid', () => {
  it('parses both queue kinds', () => {
    expect(externalQueue().kind).toBe('external');
    expect(managedQueue().kind).toBe('managed');
    expect(HumanQueueDefinition.safeParse(externalQueueInput()).success).toBe(true);
  });
});
