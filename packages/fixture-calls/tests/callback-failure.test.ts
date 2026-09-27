import {
  Cap,
  outcomeFor,
  type EngineEvent,
  type EngineOutcome,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { describe, expect, it, vi } from 'vitest';
import { runFixtureCall } from '../src/index.ts';
import { input } from './support.ts';

type Source = 'event' | 'usage' | 'recording';

async function withinDeadline(promise: Promise<unknown>): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve('still running'), 150);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function longRunning(
  source: Source,
  options: { failDispose?: boolean; duringStart?: boolean } = {},
) {
  const base = input(source === 'recording');
  const original = base.registry.get(base.release.selections.engine.pluginId)!;
  const disposed = vi.fn();
  const released = vi.fn();
  let trigger!: () => Promise<void>;
  let stop!: () => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const plugin = definePlugin(original.manifest, (ctx) => {
    const media = ctx.get(Cap.media);
    const usage = ctx.get(Cap.usage);
    const listeners = new Set<(event: EngineEvent) => void>();
    let settle!: (outcome: EngineOutcome) => void;
    const ended = new Promise<EngineOutcome>((resolve) => {
      settle = resolve;
    });
    stop = () => settle({ reason: 'drain', outcome: outcomeFor('drain') });
    trigger = async () => {
      if (source === 'event') {
        for (const fn of listeners) fn({ type: 'timing', key: 'tts_ttfb', atMs: 1, ms: 1 });
      } else if (source === 'usage') {
        usage({
          provider: 'fixture',
          operation: 'tts',
          unit: 'characters',
          quantity: '1',
          state: 'estimated',
          requestId: 'fixture:1',
          elapsedMs: 1,
        });
      } else await media.sendAudio(new Uint8Array(160));
    };
    const engine: VoiceSessionEngine = {
      ended,
      ingressStats: {
        acceptedFrames: 0,
        acceptedBytes: 0,
        pendingFrames: 0,
        pendingBytes: 0,
        overflows: 0,
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      async start() {
        ready();
        if (options.duringStart) {
          await trigger();
          await ended;
        }
      },
      async dispose(reason) {
        disposed(reason);
        stop();
        if (options.failDispose) throw new Error('engine cleanup failed');
        return ended;
      },
    };
    ctx.provide(Cap.engine, engine);
    ctx.effect(() => () => {
      released();
    });
  });
  return {
    base: {
      ...base,
      callerScript: { turns: [] },
      registry: new PluginRegistry([
        ...base.registry.list().filter((row) => row !== original),
        plugin,
      ]),
    },
    started,
    disposed,
    released,
    trigger: () => trigger(),
    stop: () => stop(),
  };
}

describe('public fixture callback failure boundary', () => {
  it.each([
    ['event', false],
    ['usage', false],
    ['recording', false],
    ['event', true],
    ['usage', true],
    ['recording', true],
  ] as const)(
    'terminates a running engine on %s failure (synchronous=%s)',
    async (source, synchronous) => {
      const fixture = longRunning(source);
      const failure = new Error(`${source} persistence refused`);
      const reject = vi.fn(() => {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      });
      const finish = vi.fn();
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => {
        unhandled.push(error);
      };
      process.on('unhandledRejection', onUnhandled);
      const call = runFixtureCall({
        ...fixture.base,
        telemetry: {
          ...(source === 'event' ? { onEvent: reject } : {}),
          ...(source === 'usage' ? { onUsage: reject } : {}),
        },
        recording: { open: () => ({ write: reject, finish }) },
      });
      const observed = call.done.then(
        () => 'unexpected success',
        (error: unknown) => error,
      );
      try {
        await fixture.started;
        await expect(fixture.trigger()).resolves.toBeUndefined();
        const result = await withinDeadline(observed);
        expect(result).toBe(failure);
        expect(fixture.disposed).toHaveBeenCalledExactlyOnceWith('error:fixture-call');
        expect(fixture.released).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledOnce();
        expect(finish).not.toHaveBeenCalled();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
      } finally {
        fixture.stop();
        await observed;
        process.off('unhandledRejection', onUnhandled);
      }
    },
  );

  it('preserves the persistence failure and releases composition even if engine cleanup rejects', async () => {
    const fixture = longRunning('event', { failDispose: true });
    const failure = new Error('event persistence refused');
    const call = runFixtureCall({
      ...fixture.base,
      telemetry: {
        onEvent: async () => {
          throw failure;
        },
      },
    });
    const observed = call.done.then(
      () => 'unexpected success',
      (error: unknown) => error,
    );
    try {
      await fixture.started;
      await fixture.trigger();
      expect(await withinDeadline(observed)).toBe(failure);
      expect(fixture.released).toHaveBeenCalledOnce();
    } finally {
      fixture.stop();
      await observed;
    }
  });

  it('terminates when a callback rejects while engine.start is still pending', async () => {
    const fixture = longRunning('event', { duringStart: true });
    const failure = new Error('startup event refused');
    const call = runFixtureCall({
      ...fixture.base,
      telemetry: {
        onEvent: async () => {
          throw failure;
        },
      },
    });
    const observed = call.done.then(
      () => 'unexpected success',
      (error: unknown) => error,
    );
    try {
      expect(await withinDeadline(observed)).toBe(failure);
      expect(fixture.disposed).toHaveBeenCalledExactlyOnceWith('error:fixture-call');
      expect(fixture.released).toHaveBeenCalledOnce();
    } finally {
      fixture.stop();
      await observed;
    }
  });

  it('still waits for successful telemetry and recording writes before finishing the artifact', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finish = vi.fn(() => ({ id: 'complete-recording' }));
    const clock = new FakeClock();
    const ended = vi.fn();
    const call = runFixtureCall({
      ...input(true),
      clock,
      telemetry: {
        onEvent: (row) => {
          if (row.event.type === 'end') ended();
          return pending;
        },
      },
      recording: { open: () => ({ write: () => pending, finish }) },
    });
    let done = false;
    const observed = call.done.then((result) => {
      done = true;
      return result;
    });
    try {
      await clock.advanceAsync(0);
      expect(ended).toHaveBeenCalledOnce();
      expect(done).toBe(false);
      expect(finish).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect((await observed).recording).toEqual({ id: 'complete-recording' });
    expect(finish).toHaveBeenCalledOnce();
  });
});
