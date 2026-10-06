import { randomUUID } from 'node:crypto';
import {
  MULAW_8K,
  type AudioFormat,
  type TextFilter,
  type TextToSpeech,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import {
  createSpeechCacheKey,
  normalizeSpeechInventory,
  staticSpeechInventory,
} from '@winsendotai/ovo-plugin-speech-cache';
import type { SpeechClipRef } from '@winsendotai/ovo-plugin-speech-cache/postgres';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { collectClip, segmentAudio } from './speech-cache-audio.ts';
import { speechCacheIdentity, selectedVoice } from './speech-cache-identity.ts';
import type { SpeechClipStore, WorkerSpeechClipCache } from './speech-cache-tiers.ts';

export interface WarmOptions {
  concurrency: number;
  attempts: number;
  renderTimeoutMs: number;
  /** Waits between attempts; tests pass zero. */
  backoffMs?: number;
}

export interface WarmResult {
  state: 'done' | 'failed' | 'skipped';
  total: number;
  /** Already in the durable tier (or pinned) before this run. */
  existing: number;
  rendered: number;
  failed: number;
  /** Another worker held the line's render lock and had not finished it. */
  deferred: number;
  perCall: number;
  inventorySha256?: string;
  detail?: string;
}

/**
 * Warms one release's fixed lines for this worker (TTS-9): computes the inventory on post-filter
 * text, loads every clip the durable tier already has into the pinned tier, and renders only the
 * missing ones, a few at a time, each under a per-key lock and with retries. Renders run under the
 * worker's own signal and the pre-render meter, never under a caller's session.
 */
export async function warmReleaseClips(
  input: {
    release: ReleaseRecord;
    tts: TextToSpeech;
    filters: readonly TextFilter[];
    onUsage: UsageSink;
    format?: AudioFormat;
    signal: AbortSignal;
  },
  deps: { cache: WorkerSpeechClipCache; store?: SpeechClipStore; options: WarmOptions },
): Promise<WarmResult> {
  const { release, tts } = input;
  const format = input.format ?? MULAW_8K;
  const inventory = normalizeSpeechInventory(
    staticSpeechInventory(release),
    input.filters,
    release.config.language,
  );
  const base = { total: inventory.texts.length, perCall: inventory.perCall };
  const empty = { existing: 0, rendered: 0, failed: 0, deferred: 0 };
  const identity = speechCacheIdentity(release, tts, format);
  if (!identity.persistent)
    return { state: 'skipped', ...base, ...empty, detail: 'tts binding is not pinned' };
  const lines = inventory.texts.map((text) => ({
    text,
    key: createSpeechCacheKey(identity.binding, text),
  }));
  const { cache, store } = deps;
  cache.activate(release);
  const stored = store
    ? await store.getMany(
        release.workspaceId,
        lines.map((line) => line.key),
      )
    : new Map<string, Uint8Array>();
  const missing = lines.filter((line) => {
    const audio = stored.get(line.key);
    if (!audio) return !cache.pinned.has(line.key, release.workspaceId);
    cache.pin(release, line.key, audio);
    return false;
  });
  const result: WarmResult = {
    state: 'done',
    ...base,
    ...empty,
    existing: lines.length - missing.length,
    inventorySha256: inventory.sha256,
  };
  const refs: SpeechClipRef[] = lines
    .filter((line) => !missing.includes(line))
    .map((line) => ({ key: line.key, status: 'ready' }));
  const sessionId = `prerender-${randomUUID()}`;
  const render = async (line: { text: string; key: string }): Promise<Uint8Array> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= deps.options.attempts; attempt += 1) {
      input.signal.throwIfAborted();
      try {
        const signal = AbortSignal.any([
          input.signal,
          AbortSignal.timeout(deps.options.renderTimeoutMs),
        ]);
        return await collectClip(
          segmentAudio(tts, {
            sessionId,
            text: line.text,
            format,
            language: release.config.language,
            voice: selectedVoice(release),
            signal,
            onUsage: input.onUsage,
          }),
          cache.maxClipBytes,
        );
      } catch (error) {
        lastError = error;
        if (input.signal.aborted) throw error;
        if (attempt < deps.options.attempts)
          await delay((deps.options.backoffMs ?? 250) * 2 ** (attempt - 1), input.signal);
      }
    }
    throw lastError;
  };
  let deferred: { text: string; key: string }[] = [];
  const one = async (line: { text: string; key: string }) => {
    const run = async (): Promise<'existing' | 'rendered'> => {
      // Another worker may have finished it while this one waited for the lock.
      const late = await store?.get(release.workspaceId, line.key);
      const audio = late ?? (await render(line));
      cache.pin(release, line.key, audio);
      const stored =
        late || !store
          ? 'exists'
          : await store.put({
              workspaceId: release.workspaceId,
              key: line.key,
              codec: format.encoding,
              sampleRate: format.sampleRate,
              audio,
            });
      if (stored === 'too-large' || stored === 'over-budget')
        throw new Error(`durable clip store refused the clip: ${stored}`);
      return late ? 'existing' : 'rendered';
    };
    try {
      const outcome = store?.withRenderLock
        ? await store.withRenderLock(release.workspaceId, line.key, run)
        : { locked: true as const, value: await run() };
      if (!outcome.locked) {
        deferred.push(line);
        return;
      }
      result[outcome.value] += 1;
      refs.push({ key: line.key, status: 'ready' });
    } catch (error) {
      if (input.signal.aborted) throw error;
      result.failed += 1;
      refs.push({ key: line.key, status: 'failed', error: errorText(error) });
    }
  };
  await pool(missing, deps.options.concurrency, one);
  // A line another worker is rendering is picked up from the durable tier once it lands there.
  for (let round = 0; deferred.length && round < 4; round += 1) {
    await delay((deps.options.backoffMs ?? 250) * 4 * 2 ** round, input.signal);
    const waiting = deferred;
    deferred = [];
    await pool(waiting, deps.options.concurrency, one);
  }
  result.deferred = deferred.length;
  await store?.markRefs(release.workspaceId, release.id, refs);
  if (result.failed) {
    result.state = 'failed';
    result.detail = `${result.failed} of ${result.total} lines failed to render`;
  }
  return result;
}

async function pool<T>(items: readonly T[], width: number, run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 500);
}
