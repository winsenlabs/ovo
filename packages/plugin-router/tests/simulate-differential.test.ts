import { describe, expect, it } from 'vitest';
import { memberKey } from '../src/simulate/host.ts';
import {
  answersOf,
  notSimulable,
  readConversations,
  snapshotFor,
  type Conversation,
} from './support-conversations.ts';
import { NOON, simulate } from './support-sim.ts';
import type { SimulationTurn } from '../src/wire/index.ts';

/**
 * The differential test (R4 design 5.5.2): every router conversation the replay suite runs through
 * the behaviour adapter is run through `simulateRoute`, and must say the same lines and record the
 * same `route.*` events. A simulator that drifted from the router would fail here first.
 */
const all = [
  ...readConversations('router-conversations.jsonl'),
  ...readConversations('router-transfer-conversations.jsonl'),
];
const simulable = all.filter((conversation) => !notSimulable(conversation));

async function run(conversation: Conversation) {
  const snapshot = snapshotFor(conversation);
  const releases = snapshot.releaseIds;
  const members = Object.values(snapshot.pools).flatMap((pool) =>
    pool.members.map((member) => ({ poolId: pool.id, memberId: member.id })),
  );
  const refused = typeof conversation.begin === 'string' ? conversation.begin : undefined;
  return simulate(
    snapshot,
    {
      call: { variables: {} },
      turns: conversation.turns.flatMap((turn): SimulationTurn[] =>
        'opening' in turn
          ? []
          : 'idle' in turn
            ? [{ kind: 'silence' as const }]
            : 'digits' in turn
              ? [{ kind: 'dtmf' as const, digits: turn.digits }]
              : 'text' in turn
                ? [{ kind: 'speech' as const, text: turn.text }]
                : [],
      ),
      engines: { answers: answersOf(conversation.engines) },
      faults: {
        fullMembers: conversation.claims === 'full' ? members : [],
        failedReleases: conversation.prepare
          ? releases.map((releaseId) => ({ releaseId, reason: 'compose_failed' as const }))
          : [],
        queues: refused === 'no_operators' ? { desk: 'no_operators' as const } : {},
      },
    },
    {
      now: NOON,
      flags: { transferEnabled: conversation.begin !== undefined, humanQueueEnabled: true },
    },
  );
}

describe('simulateRoute against the router replay conversations', () => {
  it('covers most of the conversations, and says why it skips the rest', () => {
    expect(simulable).toHaveLength(10);
    expect(all.filter(notSimulable).map(notSimulable)).toEqual([
      'it moves the clock by hand',
      'it refuses the first begin by a port trick',
      'a re-route entry is a worker feature',
      'a re-route entry is a worker feature',
    ]);
  });

  it.each(simulable.map((conversation) => [conversation.name, conversation] as const))(
    '%s',
    async (_name, conversation) => {
      const result = await run(conversation);
      expect(result.turns.map((turn) => turn.say)).toEqual(conversation.says);
      const steps = result.turns
        .flatMap((turn) => turn.steps)
        .filter((s) => s.type.startsWith('route.'));
      expect(steps.map((step) => step.type)).toEqual(conversation.events.map(([type]) => type));
      // A simulated verdict carries no model id: that is the only field a scripted answer cannot hold.
      steps.forEach((step, index) => {
        const { modelId: _model, ...expected } = conversation.events[index]![1];
        expect(step.payload).toMatchObject(expected);
      });
      expect(result.outcome.completionReason).toBe(conversation.completionReason);
    },
  );

  it('keys faults the way the host claims', () => {
    expect(memberKey('p', 'm')).toBe('p:m');
  });
});
