import { compose } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  withDialDisabledPrerender,
  type PrerenderOnlyDeps,
} from '../src/speech-cache-dial-disabled.ts';

function deps(events: string[], failSpeechCache = false, openStore?: () => Promise<never>) {
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
    openStore: vi.fn(openStore ?? (async () => store as never)),
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
    const result = withDialDisabledPrerender(composition, distribution, env, fake.value);
    expect(await result.prerenderStarted).toBe(true);

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
    const dispose = vi.spyOn(composition, 'dispose');
    const result = withDialDisabledPrerender(composition, distribution, env, fake.value);
    expect(await result.prerenderStarted).toBe(false);
    expect(events).toEqual(['close ledger', 'close store']);
    await result.dispose();
    expect(events).toEqual(['close ledger', 'close store']);
    expect(dispose).toHaveBeenCalledOnce();
  });

  // Review of wave 6: opening Postgres before returning kept an unreachable database's worker in
  // `starting` until the TCP timeout; it reported dial-disabled at once before this change.
  it('returns before the stores open, and a stop during opening never starts rendering', async () => {
    const events: string[] = [];
    let open!: () => void;
    const fake = deps(
      events,
      false,
      () =>
        new Promise<never>(
          (resolve) =>
            (open = () =>
              resolve({
                close: async () => {
                  events.push('close store');
                },
              } as never)),
        ),
    );
    const composition = await compose([], []);
    const result = withDialDisabledPrerender(composition, distribution, env, fake.value);
    expect(result.ctx).toBe(composition.ctx);
    expect(fake.value.openStore).toHaveBeenCalledOnce();
    const disposed = result.dispose();
    open();
    await disposed;
    expect(await result.prerenderStarted).toBe(false);
    expect(fake.speechCache.startPrerender).not.toHaveBeenCalled();
    expect(events).toEqual(['close speech-cache', 'close ledger', 'close store']);
  });

  it('does nothing without a database', async () => {
    const fake = deps([]);
    const composition = await compose([], []);
    const result = withDialDisabledPrerender(composition, distribution, {}, fake.value);
    expect(await result.prerenderStarted).toBe(false);
    expect(result.ctx).toBe(composition.ctx);
    expect(fake.value.openStore).not.toHaveBeenCalled();
    await composition.dispose();
  });
});
