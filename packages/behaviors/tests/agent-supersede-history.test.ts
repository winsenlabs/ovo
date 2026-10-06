import { expect, it } from 'vitest';
import { AgentConfig, type InferenceRequest } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';

function agent() {
  const requests: InferenceRequest[] = [];
  const behavior = new AgentBehavior(
    AgentConfig.parse({ name: 'Agent', mode: 'agent' }),
    {
      generate: async (request) => {
        requests.push(request);
        return { kind: 'text', text: `Answer ${requests.length}` };
      },
    },
    { execute: async () => ({}) as never },
    { workspaceId: 'local', sessionId: 'call' },
  );
  return { behavior, requests };
}

// AGT-10 + the turn driver's `TurnSpeculation` hooks: a turn superseded before the caller heard any
// of its answer comes back merged, so the next request must not carry its words twice, nor an
// interruption note for lines that never started playing.
it('withdraws a superseded utterance from the history the merged turn is answered with', async () => {
  const { behavior, requests } = agent();
  behavior.finalize({ turnId: 'turn-1', text: 'I want to pay', merged: false });
  behavior.beginTurn(0);
  await behavior.respond('I want to pay');
  behavior.cancel('superseded');
  behavior.discard('turn-1', 'superseded');
  behavior.finalize({ turnId: 'turn-2', text: 'I want to pay tomorrow', merged: true });
  behavior.beginTurn(1);
  await behavior.respond('I want to pay tomorrow');
  expect(requests[1]!.history).toEqual([]);
});

it('keeps the history of an utterance the detector merely reset', async () => {
  const { behavior, requests } = agent();
  behavior.finalize({ turnId: 'turn-1', text: 'I want to pay', merged: false });
  behavior.beginTurn(0);
  await behavior.respond('I want to pay');
  behavior.discard('turn-1', 'reset');
  behavior.discard('turn-0', 'superseded');
  behavior.beginTurn(1);
  await behavior.respond('next');
  expect(requests[1]!.history).toContainEqual({ role: 'user', content: 'I want to pay' });
});
