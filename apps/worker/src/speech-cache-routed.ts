import { createHash } from 'node:crypto';
import type { PostgresSpeechPrerenderQueue } from '@winsendotai/ovo-plugin-speech-cache/postgres';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { WorkerSpeechClipCache } from './speech-cache-tiers.ts';

/** How often routes and campaigns are re-read: new routes get warmed, dropped ones unpinned. */
export const ROUTED_REFRESH_MS = 60_000;

export const releaseKey = (release: { workspaceId: string; id: string }) =>
  `${release.workspaceId}:${release.id}`;

/**
 * A warm's key: the release, and the routing points' lines for it (R2), so a routing release that
 * gives a release new lines warms it again.
 */
export function warmKey(
  release: { workspaceId: string; id: string },
  lines: readonly string[] = [],
): string {
  if (!lines.length) return releaseKey(release);
  const digest = createHash('sha256')
    .update(JSON.stringify([...lines].sort()))
    .digest('hex');
  return `${releaseKey(release)}#${digest.slice(0, 16)}`;
}

/**
 * Pins live for as long as a route or campaign points at their release (TTS-7): the routed set is
 * handed to the cache, which lets go of releases that dropped out, and every routed release this
 * worker has not warmed yet is warmed. A release let go is warmed again if a route brings it back.
 */
export async function syncRoutedReleases(input: {
  queue: Pick<PostgresSpeechPrerenderQueue, 'routedReleases'> &
    Partial<Pick<PostgresSpeechPrerenderQueue, 'routedVoiceLines'>>;
  cache: WorkerSpeechClipCache;
  releases: { getRelease(workspaceId: string, id: string): Promise<ReleaseRecord | undefined> };
  warmed: Set<string>;
  requestWarm(release: ReleaseRecord, lines?: readonly string[]): void;
}): Promise<void> {
  const routed = await input.queue.routedReleases();
  const dropped = input.cache.retainRouted(routed.map((entry) => entry.releaseId));
  for (const key of input.warmed)
    if (dropped.some((id) => key.split('#')[0]!.endsWith(`:${id}`))) input.warmed.delete(key);
  for (const entry of routed) {
    // R2: the fixed lines its routing points give the release; new ones warm it again.
    const lines = await input.queue
      .routedVoiceLines?.(entry.workspaceId, entry.releaseId)
      // swallow-ok: without its routed lines a release still warms its own; a miss renders live.
      .catch(() => undefined);
    if (input.warmed.has(warmKey({ workspaceId: entry.workspaceId, id: entry.releaseId }, lines)))
      continue;
    const release = await input.releases.getRelease(entry.workspaceId, entry.releaseId);
    if (release) input.requestWarm(release, lines);
  }
}
