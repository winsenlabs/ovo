import { describe, expect, it } from 'vitest';
import { BoundedAudioPrefetch } from '../../../apps/worker/src/session-graph-speech-buffer.ts';

const signal = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('worker fixed-capacity speech buffer', () => {
  it('backpressures at the byte bound, wraps storage and yields owned bytes', async () => {
    const buffer = new BoundedAudioPrefetch(5);
    const reader = buffer[Symbol.asyncIterator]();
    await buffer.push(Uint8Array.of(1, 2, 3), signal());
    expect((await reader.next()).value).toEqual(Uint8Array.of(1, 2, 3));
    let settled = false;
    const writing = buffer.push(Uint8Array.of(4, 5, 6, 7, 8, 9, 10, 11), signal()).then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    const first = (await reader.next()).value!;
    expect(first).toEqual(Uint8Array.of(4, 5));
    await tick();
    expect(settled).toBe(false);
    const second = (await reader.next()).value!;
    await writing;
    expect(first).toEqual(Uint8Array.of(4, 5));
    buffer.end();
    const last = (await reader.next()).value!;
    expect([...first, ...second, ...last]).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect((await reader.next()).done).toBe(true);
  });

  it('wakes a blocked producer on abort without requiring a consumer read', async () => {
    const buffer = new BoundedAudioPrefetch(1);
    const controller = new AbortController();
    await buffer.push(Uint8Array.of(1), signal());
    const writing = buffer.push(Uint8Array.of(2), controller.signal).then(
      () => 'completed',
      () => 'aborted',
    );
    controller.abort(new Error('consumer cancelled'));
    expect(await Promise.race([writing, tick().then(() => 'still blocked')])).toBe('aborted');
    buffer.end(undefined, true);
  });

  it('detaches playback while allowing the shared cache producer to finish', async () => {
    const buffer = new BoundedAudioPrefetch(2);
    const writing = buffer.push(Uint8Array.of(1, 2, 3), signal());
    buffer.end(undefined, true);
    await writing;
    await buffer.push(Uint8Array.of(4, 5), signal());
    expect((await buffer[Symbol.asyncIterator]().next()).done).toBe(true);
  });
});
