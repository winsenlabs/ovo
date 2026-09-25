import { expect, it } from 'vitest';
import {
  AgentConfig,
  type InferenceRequest,
  type OperationRecord,
  type SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior, ContextBehavior } from '../src/index.ts';
const played = (
  text: string,
  epoch: number,
  state: 'completed' | 'interrupted' = 'completed',
): SpeechReceipt => ({
  id: crypto.randomUUID(),
  text,
  epoch,
  state,
  evidence: 'confirmed',
});

it('remembers played answers, not unplayed generated answers or interrupted text', async () => {
  const requests: InferenceRequest[] = [];
  const behavior = new ContextBehavior(AgentConfig.parse({ name: 'Context', mode: 'context' }), {
    generate: async (request) => {
      requests.push(request);
      return { kind: 'text', text: `Answer ${requests.length}` };
    },
  });
  behavior.beginTurn(0);
  await behavior.respond('First');
  behavior.beginTurn(1);
  const second = await behavior.respond('Second');
  expect(requests[1].history).toEqual([
    { role: 'user', content: 'First' },
    {
      role: 'assistant',
      content: '[The response was interrupted. Do not assume any unconfirmed words were heard.]',
    },
  ]);
  behavior.onPlayback(played(second, 1));
  behavior.beginTurn(2);
  const third = await behavior.respond('Third');
  expect(requests[2].history).toContainEqual({ role: 'assistant', content: 'Answer 2' });
  behavior.onPlayback(played(third, 2, 'interrupted'));
  behavior.beginTurn(3);
  await behavior.respond('Fourth');
  expect(JSON.stringify(requests[3].history)).not.toContain('Answer 3');
  expect(JSON.stringify(requests[3].history)).toContain('interrupted');
});

const agentConfig = () =>
  AgentConfig.parse({
    name: 'Agent',
    mode: 'agent',
    tools: [
      {
        id: 'change',
        connector: 'native',
        effect: 'write',
        confirmation: true,
        description: 'Update the appointment',
        inputSchema: { type: 'object' },
      },
    ],
    allowedTools: ['change'],
  });

it('requires completed confirmation playback and an exact affirmative before the effect', async () => {
  const effects: unknown[] = [];
  const behavior = new AgentBehavior(
    agentConfig(),
    {
      generate: async (request) =>
        request.results.length
          ? { kind: 'text', text: 'Updated.' }
          : { kind: 'tool', toolId: 'change', input: { day: 'Monday' } },
    },
    {
      execute: async (request) => {
        effects.push(request);
        return { ...request, state: 'succeeded', createdAt: new Date().toISOString() };
      },
    },
    { workspaceId: 'local', sessionId: 'call' },
  );
  behavior.beginTurn(0);
  const prompt = await behavior.respond('Move my appointment');
  expect(effects).toHaveLength(0);
  behavior.onPlayback(played(prompt, 0, 'interrupted'));
  behavior.beginTurn(1);
  const repeated = await behavior.respond('yes');
  expect(repeated).toBe(prompt);
  expect(effects).toHaveLength(0);
  behavior.onPlayback(played(repeated, 1));
  behavior.beginTurn(2);
  const qualified = await behavior.respond('yes but do not change it');
  expect(qualified).toBe(prompt);
  expect(effects).toHaveLength(0);
  behavior.onPlayback(played(qualified, 2));
  behavior.beginTurn(3);
  expect(await behavior.respond('yes')).toBe('Updated.');
  expect(effects).toHaveLength(1);
  expect(effects[0]).toMatchObject({ confirmed: true, input: { day: 'Monday' } });
});

it('does not treat injected confirmed variables as spoken write approval', async () => {
  let effects = 0;
  const behavior = new AgentBehavior(
    agentConfig(),
    { generate: async () => ({ kind: 'tool', toolId: 'change', input: {} }) },
    {
      execute: async (request) => {
        effects++;
        return { ...request, state: 'succeeded', createdAt: new Date().toISOString() };
      },
    },
    { workspaceId: 'local', sessionId: 'call' },
  );
  behavior.beginTurn(0);
  const prompt = await behavior.respond('change', { confirmed: true });
  expect(prompt).toContain('Please confirm');
  expect(effects).toBe(0);

  behavior.beginTurn(1);
  expect(await behavior.respond('yes', { confirmed: true })).toBe(prompt);
  expect(effects).toBe(0);
});

it('blocks subsequent writes after an uncertain outcome, even with another operation ID', async () => {
  let effects = 0;
  const behavior = new AgentBehavior(
    agentConfig(),
    { generate: async () => ({ kind: 'tool', toolId: 'change', input: {} }) },
    {
      execute: async (request) => {
        effects++;
        return { ...request, state: 'unknown', createdAt: new Date().toISOString() };
      },
    },
    { workspaceId: 'local', sessionId: 'call' },
  );
  behavior.beginTurn(0);
  const prompt = await behavior.respond('change');
  behavior.onPlayback(played(prompt, 0));
  behavior.beginTurn(1);
  await behavior.respond('yes');
  behavior.beginTurn(2);
  expect(await behavior.respond('change again')).toContain('reconcile');
  expect(effects).toBe(1);
});

it('retains the uncertain-write guard when a newer turn cancels a pending write', async () => {
  let resolve!: (record: OperationRecord) => void;
  let effects = 0;
  const behavior = new AgentBehavior(
    agentConfig(),
    { generate: async () => ({ kind: 'tool', toolId: 'change', input: {} }) },
    {
      execute: () => {
        effects++;
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
    { workspaceId: 'local', sessionId: 'call' },
  );
  behavior.beginTurn(0);
  const prompt = await behavior.respond('change');
  behavior.onPlayback(played(prompt, 0));
  behavior.beginTurn(1);
  const first = behavior.respond('yes');
  await Promise.resolve();
  await Promise.resolve();
  behavior.beginTurn(2);
  expect(await behavior.respond('change again')).toContain('reconcile');
  resolve({
    id: 'first',
    workspaceId: 'local',
    sessionId: 'call',
    toolId: 'change',
    input: {},
    state: 'unknown',
    createdAt: new Date().toISOString(),
  });
  await expect(first).rejects.toThrow();
  expect(effects).toBe(1);
});
