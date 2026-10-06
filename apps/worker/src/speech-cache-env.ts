import type { ByteCacheLimits } from '@winsendotai/ovo-plugin-cache';

const MIB = 1024 * 1024;

export interface SpeechPrerenderOptions {
  enabled: boolean;
  /** Renders in flight at once, across every release this worker warms. */
  concurrency: number;
  /** How often an idle worker looks for a queued publish. */
  pollMs: number;
  /** A claimed job returns to the queue when its worker stops renewing for this long. */
  leaseMs: number;
  /** One render, including retries' waits, never outlives this. */
  renderTimeoutMs: number;
  attempts: number;
  /** Clips and refs nobody used or refreshed for this long are collected. */
  retentionDays: number;
}

export interface WorkerSpeechCacheOptions {
  l1: ByteCacheLimits;
  /** In-memory clips pinned for their release's lifetime (no TTL). */
  pinnedMaxBytes: number;
  clipMaxBytes: number;
  workspaceMaxBytes: number;
  prerender: SpeechPrerenderOptions;
}

export const DEFAULT_SPEECH_CACHE_OPTIONS: WorkerSpeechCacheOptions = Object.freeze({
  l1: {},
  pinnedMaxBytes: 256 * MIB,
  clipMaxBytes: 2 * MIB,
  workspaceMaxBytes: 512 * MIB,
  prerender: Object.freeze({
    enabled: true,
    concurrency: 4,
    pollMs: 5_000,
    leaseMs: 120_000,
    renderTimeoutMs: 30_000,
    attempts: 3,
    retentionDays: 30,
  }),
});

/** Inclusive bounds for every numeric speech cache variable. */
const BOUNDS = {
  OVO_SPEECH_CACHE_TTL_MS: [1, 86_400_000],
  OVO_SPEECH_CACHE_MAX_ENTRIES: [1, 100_000],
  OVO_SPEECH_CACHE_MAX_BYTES: [1, 1024 * MIB],
  OVO_SPEECH_CACHE_MAX_ENTRY_BYTES: [1, 64 * MIB],
  OVO_SPEECH_CACHE_MAX_PENDING: [1, 10_000],
  OVO_SPEECH_CLIPS_MAX_BYTES: [1, 4096 * MIB],
  OVO_SPEECH_CLIP_MAX_BYTES: [1, 8 * MIB],
  OVO_SPEECH_CLIPS_WORKSPACE_MAX_BYTES: [1, 64 * 1024 * MIB],
  OVO_SPEECH_PRERENDER_CONCURRENCY: [1, 32],
  OVO_SPEECH_PRERENDER_POLL_MS: [100, 3_600_000],
  OVO_SPEECH_CLIPS_RETENTION_DAYS: [1, 3_650],
} as const satisfies Record<string, readonly [number, number]>;

/** Every speech cache limit is an env var; an invalid value stops the worker at startup. */
export function speechCacheOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): WorkerSpeechCacheOptions {
  const read = (name: keyof typeof BOUNDS): number | undefined => {
    const raw = env[name];
    if (!raw) return undefined;
    const [low, high] = BOUNDS[name];
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= low && value <= high) return value;
    throw new RangeError(`${name} must be a whole number from ${low} to ${high}`);
  };
  const defaults = DEFAULT_SPEECH_CACHE_OPTIONS;
  const l1 = Object.fromEntries(
    (
      [
        ['ttlMs', read('OVO_SPEECH_CACHE_TTL_MS')],
        ['maxEntries', read('OVO_SPEECH_CACHE_MAX_ENTRIES')],
        ['maxBytes', read('OVO_SPEECH_CACHE_MAX_BYTES')],
        ['maxEntryBytes', read('OVO_SPEECH_CACHE_MAX_ENTRY_BYTES')],
        ['maxPending', read('OVO_SPEECH_CACHE_MAX_PENDING')],
      ] as const
    ).filter(([, value]) => value !== undefined),
  ) as ByteCacheLimits;
  const enabled = env.OVO_SPEECH_PRERENDER_ENABLED;
  if (enabled && enabled !== 'true' && enabled !== 'false')
    throw new RangeError('OVO_SPEECH_PRERENDER_ENABLED must be true or false');
  return {
    l1,
    pinnedMaxBytes: read('OVO_SPEECH_CLIPS_MAX_BYTES') ?? defaults.pinnedMaxBytes,
    clipMaxBytes: read('OVO_SPEECH_CLIP_MAX_BYTES') ?? defaults.clipMaxBytes,
    workspaceMaxBytes: read('OVO_SPEECH_CLIPS_WORKSPACE_MAX_BYTES') ?? defaults.workspaceMaxBytes,
    prerender: {
      ...defaults.prerender,
      enabled: enabled !== 'false',
      concurrency: read('OVO_SPEECH_PRERENDER_CONCURRENCY') ?? defaults.prerender.concurrency,
      pollMs: read('OVO_SPEECH_PRERENDER_POLL_MS') ?? defaults.prerender.pollMs,
      retentionDays: read('OVO_SPEECH_CLIPS_RETENTION_DAYS') ?? defaults.prerender.retentionDays,
    },
  };
}
