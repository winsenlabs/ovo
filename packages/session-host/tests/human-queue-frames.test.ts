import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { DropOldestQueue, RoomFramer } from '../src/human-queue/frames.ts';

describe('the room frame helpers (human queue design 7.5)', () => {
  it('re-frames any chunking of 8 kHz mu-law into whole 20 ms (160 byte) frames', () => {
    const framer = new RoomFramer(MULAW_8K);
    expect(framer.push(new Uint8Array(100)).length).toBe(0);
    expect(framer.push(new Uint8Array(300)).map((frame) => frame.length)).toEqual([160, 160]);
    expect(framer.push(new Uint8Array(80)).map((frame) => frame.length)).toEqual([160]);
  });

  it('drops the oldest frames past its capacity and counts them', () => {
    const queue = new DropOldestQueue(3);
    for (let i = 0; i < 5; i += 1) queue.push(new Uint8Array([i]));
    expect(queue.dropped).toBe(2);
    expect(queue.length).toBe(3);
    expect(queue.peek()![0]).toBe(2);
    expect(queue.shift()![0]).toBe(2);
    queue.clear();
    expect(queue.length).toBe(0);
  });
});
