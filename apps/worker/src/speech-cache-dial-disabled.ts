import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import { PostgresCostLedger } from '@winsendotai/ovo-plugin-ledger';
import { PostgresControlStore } from '@winsendotai/ovo-plugin-storage';
import type { Composition } from '@winsendotai/ovo-runtime';
import type { ReleaseSpeechDeps } from './speech-cache-release-tts.ts';
import { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import { workerSecretManager } from './worker-secrets.ts';

export interface PrerenderOnlyDeps {
  openStore(databaseUrl: string): Promise<PostgresControlStore>;
  openLedger(databaseUrl: string): Promise<PostgresCostLedger>;
  openSpeechCache(
    env: Readonly<Record<string, string | undefined>>,
    databaseUrl: string,
  ): Promise<WorkerSpeechCacheRuntime>;
  secrets(store: PostgresControlStore): ReturnType<typeof workerSecretManager>;
}

const PRERENDER_ONLY_DEPS: PrerenderOnlyDeps = {
  openStore: (databaseUrl) => PostgresControlStore.open(databaseUrl),
  openLedger: async (databaseUrl) => {
    const ledger = new PostgresCostLedger({ connectionString: databaseUrl });
    await ledger.migrate();
    return ledger;
  },
  openSpeechCache: (env, databaseUrl) => WorkerSpeechCacheRuntime.fromEnvironment(env, databaseUrl),
  secrets: (store) => workerSecretManager(store),
};

/**
 * Pre-rendering needs no carrier. A dial-disabled worker used to return before `startPrerender`,
 * so releases published while live dialing was off (setup, a deploy, `ovo-live.sh off`) went live
 * with no clips and synthesized every fixed line on the first calls. It now claims publish jobs and
 * warms routed releases into the durable clip store, metered as pre-render usage; nothing that
 * dials (runner, carrier, protection, cost runtime) is composed. Best effort and off the startup
 * path: the worker reports dial-disabled health at once, as before, while the clip store and its
 * credentials open in the background; if they cannot, it stays dial-disabled and healthy.
 */
export function withDialDisabledPrerender(
  composition: Composition,
  distribution: Pick<ReleaseSpeechDeps, 'catalog' | 'defaults'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: PrerenderOnlyDeps = PRERENDER_ONLY_DEPS,
): Composition & { prerenderStarted: Promise<boolean> } {
  const workerId = env.OVO_WORKER_ID ?? `compact-${process.pid}`;
  const log = createLogger({ service: 'worker', workerId, component: 'speech-prerender' });
  const databaseUrl = env.OVO_CONTROL_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) return { ...composition, prerenderStarted: Promise.resolve(false) };
  const opened: { close(): Promise<void> }[] = [];
  let disposed = false;
  const prerenderStarted = (async () => {
    try {
      const controlStore = await deps.openStore(databaseUrl);
      opened.push(controlStore);
      const ledger = await deps.openLedger(databaseUrl);
      opened.push(ledger);
      const speechCache = await deps.openSpeechCache(env, databaseUrl);
      opened.push(speechCache);
      // A worker stopped while the stores were opening never starts rendering.
      if (disposed) throw new Error('worker stopped before pre-render started');
      const service = speechCache.startPrerender({
        workerId,
        releases: controlStore,
        ledger,
        log,
        speech: {
          catalog: distribution.catalog,
          parent: composition,
          secrets: deps.secrets(controlStore),
          defaults: distribution.defaults,
        },
      });
      log.info('speech_prerender_dial_disabled', { running: Boolean(service) });
      return true;
    } catch (error) {
      if (!disposed) log.warn('speech_prerender_unavailable', errorFields(error));
      await closeAll(opened);
      return false;
    }
  })();
  return {
    ...composition,
    prerenderStarted,
    // The speech cache closes first: its renders compose under this composition's net.
    dispose: async () => {
      disposed = true;
      await prerenderStarted;
      await closeAll(opened);
      await composition.dispose();
    },
  };
}

async function closeAll(resources: { close(): Promise<void> }[]): Promise<void> {
  for (const resource of resources.splice(0).reverse())
    await resource.close().catch(() => undefined);
}
