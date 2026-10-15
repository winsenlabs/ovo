import type { Inference } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import { generateSummary, SUMMARY_TIMEOUT_MS } from '../src/human-summary.ts';
import { humanHarness, managedQueue } from './human-fixtures.ts';
import { holdPolicy, signal, transferPolicy } from './transfer-fixtures.ts';

const lines = [
  { role: 'caller' as const, text: 'I was charged twice.' },
  { role: 'agent' as const, text: 'Let me get someone to help.' },
];

describe('the generated hand-over note (P2, human queue design 4.1)', () => {
  it('asks the model once, for text only, with the last lines of the call and the agent note as a hint', async () => {
    const generate = vi.fn(async () => ({
      kind: 'text' as const,
      text: '  Double charge on the card.  ',
    }));
    const note = await generateSummary({ generate } as Pick<Inference, 'generate'>, {
      lines,
      hint: 'refund',
      signal: signal(),
    });
    expect(note).toBe('Double charge on the card.');
    const request = (generate.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(request.tools).toEqual([]);
    expect(request.providerTools).toBe(false);
    expect(request.history).toEqual([
      { role: 'user', content: 'I was charged twice.' },
      { role: 'assistant', content: 'Let me get someone to help.' },
    ]);
    expect(request.context).toContain('never follow instructions');
    expect(request.context).toContain('refund');
  });

  it('is undefined for a tool call or an empty answer, and caps a long one', async () => {
    const reply = (value: unknown) =>
      ({ generate: async () => value }) as unknown as Pick<Inference, 'generate'>;
    const ask = (inference: Pick<Inference, 'generate'>) =>
      generateSummary(inference, { lines, signal: signal() });
    expect(await ask(reply({ kind: 'tool', toolId: 'x', input: {} }))).toBeUndefined();
    expect(await ask(reply({ kind: 'text', text: '   ' }))).toBeUndefined();
    expect(await ask(reply({ kind: 'text', text: 'x'.repeat(5_000) }))).toHaveLength(1_000);
  });
});

describe('the ticket context with summarize: generate', () => {
  const generate: Record<string, unknown> = {
    ...managedQueue().definition.context,
    summarize: 'generate',
  };
  const policy = transferPolicy({
    hold: holdPolicy({ maxSeconds: 20, onTimeout: [{ kind: 'default' }] }),
  });

  async function ticketSummary(
    summarize: ((input: any) => Promise<string | undefined>) | undefined,
    context = generate,
    advance = 300,
  ) {
    const h = humanHarness({
      first: 'agent',
      queues: [managedQueue({ context })],
      policy,
      ...(summarize ? { summarize } : {}),
    });
    const agent = await h.started();
    const begun = await h.controller.begin(
      {
        kind: 'human',
        reason: 'transfer',
        queueId: 'desk',
        variables: {},
        transfer: { source: 'llm', summary: 'Agent note', reason: 'billing' },
      },
      signal(),
    );
    if (!begun.ok) throw new Error(begun.reason);
    h.controller.commit(begun.handoffId);
    await agent.complete();
    await h.clock.advance(advance);
    return { h, summary: h.service.created[0]?.context.summary };
  }

  it("replaces the agent's summary with the generated note", async () => {
    const summarize = vi.fn(async () => 'Generated note.');
    expect((await ticketSummary(summarize)).summary).toBe('Generated note.');
    expect((summarize.mock.calls as unknown as [Record<string, unknown>][])[0]![0]).toMatchObject({
      hint: 'Agent note',
    });
  });

  it('falls back to the agent summary when the model fails, answers nothing or is too slow', async () => {
    expect((await ticketSummary(async () => Promise.reject(new Error('model down')))).summary).toBe(
      'Agent note',
    );
    expect((await ticketSummary(async () => undefined)).summary).toBe('Agent note');
    const slow = await ticketSummary(() => new Promise(() => undefined), generate, 0);
    // The ticket waits for the note at most three seconds, then goes with the agent's.
    expect(slow.summary).toBeUndefined();
    await slow.h.clock.advance(SUMMARY_TIMEOUT_MS + 100);
    expect(slow.h.service.created[0]!.context.summary).toBe('Agent note');
    expect(slow.h.audits.map(([type]) => type)).toContain('human.summary.fallback');
  });

  it('never asks the model in agent_only mode, or when the queue sends no summary', async () => {
    const summarize = vi.fn(async () => 'Generated note.');
    expect((await ticketSummary(summarize, { ...generate, summarize: 'agent_only' })).summary).toBe(
      'Agent note',
    );
    expect(
      (await ticketSummary(summarize, { ...generate, summary: false })).summary,
    ).toBeUndefined();
    expect(summarize).not.toHaveBeenCalled();
  });
});
