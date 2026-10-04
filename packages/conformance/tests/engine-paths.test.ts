import { describe, expect, it } from 'vitest';
import { ENGINE_SCENARIOS, Failures, createReferenceEngine, startHarness } from '../src/index.ts';

const scenario = (name: string) => ENGINE_SCENARIOS.find((s) => s.name.startsWith(name))!;

describe('engine kit scenarios exercise the paths they claim', () => {
  it('enables input for a scripted announcement', async () => {
    const harness = await startHarness(
      { factory: createReferenceEngine, options: {} },
      {
        agent: {
          mode: 'announcement',
          script: {
            start: 'ask',
            nodes: [
              {
                id: 'ask',
                prompt: 'Press one to continue.',
                transitions: [{ event: 'dtmf', matches: ['1'], to: 'done' }],
              },
              { id: 'done', prompt: 'Thank you.', terminal: true },
            ],
          },
        },
      },
    );
    try {
      expect(harness.session.inputEnabled).toBe(true);
      expect(harness.stt.sessions).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('the interrupted-confirmation scenario really interrupts the prompt with the kit detector', async () => {
    const chosen = scenario('an interrupted confirmation');
    const harness = await startHarness(
      { factory: createReferenceEngine, options: {} },
      chosen.setup,
    );
    const f = new Failures();
    try {
      await chosen.run(harness, f);
    } finally {
      await harness.close();
    }
    expect(f.messages).toEqual([]);
    const prompt = harness.receipts().find((r) => /confirm/i.test(r.receipt.text));
    expect(prompt?.receipt.state).toBe('interrupted');
    expect(harness.executes()).toHaveLength(0);
  }, 30_000);

  it("the 'yes'-during-prompt scenario holds the answer until the completed receipt", async () => {
    const chosen = scenario("'yes' during the confirmation prompt");
    const harness = await startHarness(
      { factory: createReferenceEngine, options: {} },
      chosen.setup,
    );
    const f = new Failures();
    try {
      await chosen.run(harness, f);
    } finally {
      await harness.close();
    }
    expect(f.messages).toEqual([]);
    expect(harness.events().some((e) => e.type === 'interrupt')).toBe(false);
  }, 30_000);
});
