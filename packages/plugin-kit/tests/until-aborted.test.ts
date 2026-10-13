import { describe, expect, it } from 'vitest';
import { untilAborted } from '../src/index.ts';

describe('untilAborted', () => {
  it('settles with the work while the signal stays quiet, and lets go of the signal', async () => {
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listeners += 1;
      add(...args);
    }) as typeof add;
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      listeners -= 1;
      remove(...args);
    }) as typeof remove;
    await expect(untilAborted(Promise.resolve(7), controller.signal)).resolves.toBe(7);
    await expect(
      untilAborted(Promise.reject(new Error('connect failed')), controller.signal),
    ).rejects.toThrow('connect failed');
    expect(listeners).toBe(0);
  });

  it('rejects with the abort reason as soon as the signal aborts, before the work settles', async () => {
    const controller = new AbortController();
    let finish!: (value: string) => void;
    const work = new Promise<string>((resolve) => (finish = resolve));
    const waiting = untilAborted(work, controller.signal);
    const reason = new Error('barge-in');
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    finish('late');
    await expect(work).resolves.toBe('late');
  });

  it('rejects at once for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(untilAborted(new Promise(() => {}), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
