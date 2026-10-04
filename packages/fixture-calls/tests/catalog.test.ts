import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FakeClock, withEgressSentinel } from '@winsendotai/ovo-conformance/drivers';
import { FIRST_PARTY } from '../../distribution/src/catalog.ts';
import type { runFixtureCall } from '../src/run.ts';
import { input } from './support.ts';

describe('fixture-call production catalog entry', () => {
  it('loads the public host library and runs selected media, providers and telemetry without live ports', async () => {
    const entry = FIRST_PARTY.find((item) => item.package === '@winsendotai/ovo-fixture-calls');
    expect(entry?.roles).toEqual(['api']);
    const clock = new FakeClock();
    const result = await withEgressSentinel(
      async (sentinel) => {
        const library = (await entry!.load()) as {
          runFixtureCall: typeof runFixtureCall;
          plugins: unknown[];
        };
        // This is a host library. It must expose execution through its public export,
        // while its catalog registration must not add an application plugin.
        expect(library.plugins).toEqual([]);
        const events: string[] = [];
        const call = library.runFixtureCall({
          ...input(),
          clock,
          telemetry: {
            onEvent: ({ event }) => {
              events.push(event.type);
            },
          },
        });
        await clock.advanceAsync(0);
        const completed = await call.done;
        expect(events).toEqual(
          expect.arrayContaining(['user.transcript', 'speech', 'timing', 'end']),
        );
        expect(sentinel.attempts).toEqual([]);
        return completed;
      },
      { allowLoopback: false },
    );
    expect(result.outcome).toEqual({ reason: 'behavior_completed', outcome: 'completed' });
    expect(result.selections.engine?.id).toBe('fixture-test-engine');
    expect(result.sttMode).toBe('template');
    expect(result.carrierFrames.some((frame) => JSON.parse(frame).event === 'media')).toBe(true);
    expect(result.usage.length).toBeGreaterThan(0);
    expect(result.usage.every((meter) => meter.state === 'estimated')).toBe(true);
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    expect(
      manifest.ovo?.skeleton,
      'The executed host library must no longer claim a skeleton exemption',
    ).not.toBe(true);
  });
});
