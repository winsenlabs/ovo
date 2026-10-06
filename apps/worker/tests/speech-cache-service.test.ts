import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import type { PrerenderJob } from '@winsendotai/ovo-plugin-speech-cache/postgres';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import {
  DEFAULT_SPEECH_CACHE_OPTIONS,
  speechCacheOptionsFromEnv,
} from '../src/speech-cache-env.ts';
import { PrerenderSkipError } from '../src/speech-cache-release-tts.ts';
import { WorkerSpeechCacheRuntime } from '../src/speech-cache-runtime.ts';
import { SpeechPrerenderService } from '../src/speech-cache-service.ts';
import { WorkerSpeechClipCache } from '../src/speech-cache-tiers.ts';
import { fixtureRelease, RecordingTts } from './speech-cache-harness.ts';

const silent = createLogger({}, { sink: () => undefined });
const options = { ...DEFAULT_SPEECH_CACHE_OPTIONS.prerender, pollMs: 5, backoffMs: 0 };

function job(release: ReleaseRecord): PrerenderJob {
  return {
    workspaceId: release.workspaceId,
    releaseId: release.id,
    agentId: release.agentId,
    reason: 'publish',
    state: 'running',
    total: 0,
    perCall: 0,
    inventorySha256: null,
    detail: null,
    attempts: 1,
    workerId: 'worker-1',
    requestedAt: '2026-10-06T00:00:00.000Z',
    finishedAt: null,
  };
}

function harness(
  releases: ReleaseRecord[],
  queued: PrerenderJob[] = [],
  routed: ReleaseRecord[] = [],
) {
  const tts = new RecordingTts();
  const cache = new WorkerSpeechClipCache();
  const finished: unknown[] = [];
  const opened: string[] = [];
  const service = new SpeechPrerenderService({
    cache,
    options,
    workerId: 'worker-1',
    log: silent,
    releases: {
      getRelease: async (_workspace, id) => releases.find((release) => release.id === id),
    },
    queue: {
      claim: async () => queued.shift(),
      finish: async (input) => {
        finished.push(input);
      },
      routedReleases: async () =>
        routed.map((release) => ({ workspaceId: release.workspaceId, releaseId: release.id })),
    },
    openSpeech: async (release) => {
      opened.push(release.id);
      if (!release.selections?.tts)
        throw new PrerenderSkipError('release has no pinned tts selection');
      return { tts, filters: [], close: async () => undefined };
    },
  });
  return { service, cache, tts, finished, opened };
}

describe('speech prerender service', () => {
  it('warms routed releases when the worker starts, before any call', async () => {
    const routed = fixtureRelease({ speechCache: { enabled: true }, clarification: 'Sorry?' });
    const { service, cache, tts } = harness([routed], [], [routed]);
    service.start();
    await vi.waitFor(() => expect(tts.calls.length).toBeGreaterThan(0));
    await service.idle();
    expect(cache.pinned.stats.entries).toBe(tts.calls.length);
    await service.close();
  });

  it('warms a release on its first call on this worker, once', async () => {
    const release = fixtureRelease({ speechCache: { enabled: true } }, { id: 'release-first' });
    const { service, cache, opened } = harness([release]);
    service.start();
    cache.sessionStarted(release);
    cache.sessionStarted(release);
    await vi.waitFor(() => expect(opened).toEqual(['release-first']));
    await service.idle();
    cache.sessionStarted(release);
    await service.idle();
    expect(opened).toEqual(['release-first']);
    await service.close();
  });

  it('runs a queued publish and records the outcome on the job', async () => {
    const release = fixtureRelease({ speechCache: { enabled: true } }, { id: 'release-pub' });
    const missing = { ...job(release), releaseId: 'release-gone' };
    const unbound = fixtureRelease(
      { speechCache: { enabled: true } },
      { id: 'release-x', selections: {} },
    );
    const { service, finished } = harness(
      [release, unbound],
      [job(release), missing, job(unbound)],
    );
    service.start();
    await vi.waitFor(() => expect(finished).toHaveLength(3));
    expect(finished).toEqual([
      expect.objectContaining({ releaseId: 'release-pub', state: 'done', total: 4 }),
      expect.objectContaining({
        releaseId: 'release-gone',
        state: 'skipped',
        detail: 'release not found',
      }),
      expect.objectContaining({
        releaseId: 'release-x',
        state: 'skipped',
        detail: 'release has no pinned tts selection',
      }),
    ]);
    await service.close();
  });

  it('does nothing for a release that does not opt in to the speech cache', async () => {
    const off = fixtureRelease({}, { id: 'release-off' });
    const { service, opened, cache } = harness([off]);
    service.start();
    cache.sessionStarted(off);
    await service.idle();
    expect(opened).toEqual([]);
    await service.close();
  });

  it('is started and stopped by the worker runtime', async () => {
    const runtime = new WorkerSpeechCacheRuntime();
    const release = fixtureRelease({ speechCache: { enabled: true } });
    const tts = new RecordingTts();
    const service = runtime.startPrerender({
      workerId: 'worker-1',
      log: silent,
      releases: { getRelease: async () => release },
      openSpeech: async () => ({ tts, filters: [], close: async () => undefined }),
    })!;
    runtime.cache.sessionStarted(release);
    await vi.waitFor(() => expect(tts.calls.length).toBe(4));
    await service.idle();
    await runtime.close();
    expect(runtime.cache.pinned.stats.entries).toBe(0);
  });
});

describe('speech cache env', () => {
  it('reads every limit from the environment and rejects invalid values', () => {
    expect(speechCacheOptionsFromEnv({})).toEqual(DEFAULT_SPEECH_CACHE_OPTIONS);
    const options = speechCacheOptionsFromEnv({
      OVO_SPEECH_CACHE_TTL_MS: '60000',
      OVO_SPEECH_CACHE_MAX_ENTRIES: '512',
      OVO_SPEECH_CACHE_MAX_BYTES: '67108864',
      OVO_SPEECH_CLIPS_MAX_BYTES: '1048576',
      OVO_SPEECH_CLIPS_WORKSPACE_MAX_BYTES: '2097152',
      OVO_SPEECH_PRERENDER_CONCURRENCY: '8',
      OVO_SPEECH_PRERENDER_ENABLED: 'false',
      OVO_SPEECH_CLIPS_RETENTION_DAYS: '7',
    });
    expect(options).toMatchObject({
      l1: { ttlMs: 60_000, maxEntries: 512, maxBytes: 67_108_864 },
      pinnedMaxBytes: 1_048_576,
      workspaceMaxBytes: 2_097_152,
      prerender: { concurrency: 8, enabled: false, retentionDays: 7 },
    });
    expect(() => speechCacheOptionsFromEnv({ OVO_SPEECH_PRERENDER_CONCURRENCY: '0' })).toThrow(
      /OVO_SPEECH_PRERENDER_CONCURRENCY/,
    );
    expect(() => speechCacheOptionsFromEnv({ OVO_SPEECH_PRERENDER_ENABLED: 'yes' })).toThrow();
    const runtime = new WorkerSpeechCacheRuntime({}, options);
    expect(
      runtime.startPrerender({
        workerId: 'w',
        releases: { getRelease: async () => undefined },
        openSpeech: async () => {
          throw new Error('not used');
        },
      }),
    ).toBeUndefined();
  });
});
