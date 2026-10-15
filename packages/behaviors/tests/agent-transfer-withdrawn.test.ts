import { describe, expect, it } from 'vitest';
import type { InferenceReply } from '@winsendotai/ovo-contracts';
import { transferAgent, transferCall, transferPort } from './transfer-fixture.ts';

const answer: InferenceReply = { kind: 'text', text: 'I can help you with that here.' };

describe('transfer_to_agent withdrawn by the call limits (transfer design 7.3)', () => {
  it('is not offered, yet a model that calls it is refused by the host, which records why', async () => {
    const port = transferPort({
      targets: [],
      result: () => ({ ok: false, reason: 'limit_reached' }),
    });
    const t = transferAgent({ port, replies: [transferCall('billing'), answer] });
    expect(await t.turn('put me through to billing')).toEqual([answer.text]);
    const tools = t.model!.requests[0]!.tools.map((tool) => tool.id);
    expect(tools).not.toContain('transfer_to_agent');
    expect(port.requests).toEqual([{ key: 'billing', source: 'llm', confirmed: false }]);
    expect(t.model!.requests[1]!.results).toMatchObject([
      {
        toolId: 'transfer_to_agent',
        state: 'failed',
        error: expect.stringMatching(/not available/),
      },
    ]);
    expect(port.commits).toEqual([]);
    expect(t.behavior.isComplete()).toBe(false);
  });

  it('is never asked of the host when this agent does not transfer by tool', async () => {
    const port = transferPort({ targets: [] });
    const t = transferAgent({
      port,
      agents: { llmTool: false },
      replies: [transferCall('billing'), answer],
    });
    await t.turn('put me through to billing');
    expect(port.requests).toEqual([]);
  });

  it('a transfer the host begins anyway is cancelled, never taken', async () => {
    const port = transferPort({ targets: [] });
    const t = transferAgent({ port, replies: [transferCall('billing'), answer] });
    expect(await t.turn('billing please')).toEqual([answer.text]);
    expect(port.cancels).toEqual(['t1']);
    expect(port.commits).toEqual([]);
    expect(t.behavior.completionReason()).toBeUndefined();
  });
});
