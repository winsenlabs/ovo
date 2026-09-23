import { describe, expect, it } from 'vitest';
import { ENGINE_SCENARIOS, Failures, createReferenceEngine, startHarness } from '../src/index.ts';

const scenario = (name: string) => ENGINE_SCENARIOS.find((s) => s.name.startsWith(name))!;

describe('engine kit scenarios exercise the paths they claim', () => {
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
