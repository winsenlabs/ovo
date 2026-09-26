import { expect, it, vi } from 'vitest';
import { AgentConfig, type ExecutionRequest } from '@winsendotai/ovo-contracts';
import { createAgentBehavior } from '../../behaviors/src/index.ts';
import {
  createFakeCarrier,
  createScriptedInference,
  createScriptedStt,
  createScriptedTts,
  realClock,
  withEgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';

/** No kit spyBehavior or prompt regex: this is the real production Behavior contract. */
it('a production AgentBehavior accepts tail yes only after its exact confirmation receipt', async () => {
  await withEgressSentinel(
    async (sentinel) => {
      const { LiveKitEngine } = await import('../src/session-runner.ts');
      const carrier = createFakeCarrier({ playback: 'manual' }),
        stt = createScriptedStt();
      const executions: ExecutionRequest[] = [];
      const behavior = createAgentBehavior(
        AgentConfig.parse({
          name: 'Booking',
          mode: 'agent',
          language: 'en-US',
          allowedTools: ['book_table'],
          tools: [
            {
              id: 'book_table',
              description: 'Book a table',
              connector: 'native',
              effect: 'write',
              confirmation: true,
              timeoutMs: 5000,
              inputSchema: {
                type: 'object',
                properties: { party: { type: 'integer' } },
                required: ['party'],
              },
            },
          ],
        }),
        createScriptedInference([
          { kind: 'tool', toolId: 'book_table', input: { party: 2 } },
          { kind: 'text', text: 'Your table is booked.' },
        ]),
        {
          async execute(request) {
            executions.push(request);
            return {
              ...request,
              toolId: request.toolId,
              state: 'succeeded',
              result: { ok: true },
              createdAt: new Date(0).toISOString(),
            };
          },
        },
        { workspaceId: 'w1', sessionId: carrier.duplex.sessionId },
      );
      const engine = new LiveKitEngine({
        media: carrier.duplex,
        stt,
        tts: createScriptedTts(),
        behavior,
        clock: realClock,
        usage() {},
        session: {
          mode: 'agent',
          language: 'en-US',
          inputEnabled: true,
          variables: {},
          maxCallSeconds: 30,
          acknowledgements: [],
        },
      });
      try {
        await engine.start();
        const caller = await stt.session();
        caller.say('book a table for two');
        await vi.waitFor(
          () => expect(carrier.log.some((event) => event.type === 'mark')).toBe(true),
          { timeout: 10000 },
        );
        caller.say('yes');
        // Leave the real speech active through the SDK's endpoint timer. No transport ack yet.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(executions).toHaveLength(0);
        carrier.drain();
        await vi.waitFor(() => expect(executions).toHaveLength(1), { timeout: 5000 });
        expect(executions[0]?.confirmed).toBe(true);
        expect(sentinel.attempts).toEqual([]);
      } finally {
        await engine.dispose('drain');
      }
    },
    { allowLoopback: false },
  );
}, 60000);
