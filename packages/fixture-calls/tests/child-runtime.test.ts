import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TestCallRuntime } from '../../../apps/api/src/test-call-runtime.ts';

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(),
    disconnect: vi.fn(() => {
      child.connected = false;
    }),
    kill: vi.fn(),
  });
  return child;
}

describe('fixture child IPC boundary', () => {
  it('rejects and releases capacity immediately when event persistence fails before child completion', async () => {
    const child = fakeChild();
    const runtime = new TestCallRuntime({
      enabled: true,
      forkChild: () => child as never,
      wallTimeoutMs: 5_000,
    });
    let result = 'pending';
    const done = runtime
      .start({ callId: 'fixture-probe', release: {} as never }, async () => {
        throw new Error('audit write refused');
      })
      .then(
        () => {
          result = 'resolved';
        },
        (cause) => {
          result = cause.message;
        },
      );
    try {
      child.emit('message', {
        type: 'event',
        event: { seq: 1, atMs: 0, event: { type: 'user.transcript', text: 'hello', final: true } },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(result).toBe('audit write refused');
      expect(runtime.activeCount).toBe(0);
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      child.emit('message', { type: 'error', message: 'child completion' });
      await done;
    }
  });

  it('cleans up the child and releases capacity if sending its initial job throws', async () => {
    const child = fakeChild();
    child.send.mockImplementation(() => {
      throw new Error('IPC send refused');
    });
    const runtime = new TestCallRuntime({
      enabled: true,
      forkChild: () => child as never,
      wallTimeoutMs: 5_000,
    });
    try {
      await expect(runtime.start({ callId: 'send-probe', release: {} as never })).rejects.toThrow(
        'IPC send refused',
      );
      expect(runtime.activeCount).toBe(0);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.disconnect).toHaveBeenCalledOnce();
      expect(child.eventNames()).toEqual([]);
    } finally {
      child.emit('message', { type: 'error', message: 'probe cleanup' });
    }
  });

  it('persists child events in order before returning its successful result', async () => {
    const child = fakeChild();
    const runtime = new TestCallRuntime({ enabled: true, forkChild: () => child as never });
    let releaseWrite!: () => void;
    const durable = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const observed: number[] = [];
    let completed = false;
    const done = runtime
      .start({ callId: 'ordered', release: {} as never }, async (row) => {
        observed.push(row.seq);
        await durable;
      })
      .then((result) => {
        completed = true;
        return result;
      });
    child.emit('message', { type: 'event', event: { seq: 1 } });
    child.emit('message', { type: 'event', event: { seq: 2 } });
    child.emit('message', { type: 'result', result: { callId: 'ordered' } });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observed).toEqual([1]);
      expect(completed).toBe(false);
      expect(runtime.activeCount).toBe(1);
    } finally {
      releaseWrite();
    }
    expect(await done).toEqual({ callId: 'ordered' });
    expect(observed).toEqual([1, 2]);
    expect(runtime.activeCount).toBe(0);
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.eventNames()).toEqual([]);
  });
});
