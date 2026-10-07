import { compose } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  withDialDisabledPrerender,
  type PrerenderOnlyDeps,
} from '../src/speech-cache-dial-disabled.ts';

function deps(events: string[], failSpeechCache = false) {
  const resource = (name: string) => ({
    close: vi.fn(async () => {
      events.push(`close ${name}`);
    }),
  });
  const store = resource('store');
  const ledger = resource('ledger');
  const speechCache = {
    ...resource('speech-cache'),
    startPrerender: vi.fn(() => ({}) as never),
  };
  const secrets = { forAgent: vi.fn() };
  const value: PrerenderOnlyDeps = {
    openStore: vi.fn(async () => store as never),
    openLedger: vi.fn(async () => ledger as never),
    openSpeechCache: vi.fn(async () => {
      if (failSpeechCache) throw new Error('clip store unreachable');
      return speechCache as never;
    }),
    secrets: vi.fn(() => secrets as never),
  };
  return { value, store, ledger, speechCache, secrets };
}

const env = { DATABASE_URL: 'postgres://db/ovo', OVO_WORKER_ID: 'compact-worker-1' };
const distribution = { catalog: [], defaults: {} };

describe('a dial-disabled worker still pre-renders speech', () => {
  // 2026-10-07: with OVO_LIVE_DIAL_ENABLED=false the worker returned before startPrerender, so
  // releases published during setup reached go-live with no clips.
  it('starts the pre-render service under the dial-disabled composition', async () => {
    const events: string[] = [];
    const fake = deps(events);
    const composition = await compose([], []);
    const dispose = vi.spyOn(composition, 'dispose');
    const result = await withDialDisabledPrerender(composition, distribution, env, fake.value);

    expect(fake.value.openStore).toHaveBeenCalledWith('postgres://db/ovo');
    expect(fake.speechCache.startPrerender).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: 'compact-worker-1',
        releases: fake.store,
        ledger: fake.ledger,
        speech: expect.objectContaining({
          catalog: [],
          parent: composition,
          secrets: fake.secrets,
        }),
      }),
    );
    expect(result.ctx).toBe(composition.ctx);

    await result.dispose();
    expect(events).toEqual(['close speech-cache', 'close ledger', 'close store']);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stays dial-disabled and healthy when the clip store cannot open', async () => {
    const events: string[] = [];
    const fake = deps(events, true);
    const composition = await compose([], []);
    const result = await withDialDisabledPrerender(composition, distribution, env, fake.value);
    expect(result).toBe(composition);
    expect(events).toEqual(['close ledger', 'close store']);
    await result.dispose();
  });

  it('does nothing without a database', async () => {
    const fake = deps([]);
    const composition = await compose([], []);
    expect(await withDialDisabledPrerender(composition, distribution, {}, fake.value)).toBe(
      composition,
    );
    expect(fake.value.openStore).not.toHaveBeenCalled();
    await composition.dispose();
  });
});
