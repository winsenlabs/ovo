import { describe, expect, it, vi } from 'vitest';
import { adaptV1Engine } from '../src/v1-engine-adapter.ts';

describe('exact-pinned v1 engine host adapter', () => {
  it('starts the old engine and publishes one end event on disposal', async () => {
    const start = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const engine = adaptV1Engine({ start, dispose });
    const events: unknown[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();
    const first = await engine.dispose('caller_hangup');
    expect(first).toEqual({ reason: 'caller_hangup', outcome: 'caller_ended' });
    expect(await engine.ended).toEqual(first);
    expect(await engine.dispose('drain')).toEqual(first);
    expect(start).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: 'end', reason: 'caller_hangup' }]);
  });
});
