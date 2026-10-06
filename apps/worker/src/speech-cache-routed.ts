import type { PostgresSpeechPrerenderQueue } from '@winsendotai/ovo-plugin-speech-cache/postgres';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { WorkerSpeechClipCache } from './speech-cache-tiers.ts';

/** How often routes and campaigns are re-read: new routes get warmed, dropped ones unpinned. */
export const ROUTED_REFRESH_MS = 60_000;

export const releaseKey = (release: { workspaceId: string; id: string }) =>
  `${release.workspaceId}:${release.id}`;

/**
 * Pins live for as long as a route or campaign points at their release (TTS-7): the routed set is
 * handed to the cache, which lets go of releases that dropped out, and every routed release this
 * worker has not warmed yet is warmed. A release let go is warmed again if a route brings it back.
 */
export async function syncRoutedReleases(input: {
  queue: Pick<PostgresSpeechPrerenderQueue, 'routedReleases'>;
  cache: WorkerSpeechClipCache;
  releases: { getRelease(workspaceId: string, id: string): Promise<ReleaseRecord | undefined> };
  warmed: Set<string>;
  requestWarm(release: ReleaseRecord): void;
}): Promise<void> {
  const routed = await input.queue.routedReleases();
  const dropped = input.cache.retainRouted(routed.map((entry) => entry.releaseId));
  for (const key of input.warmed)
    if (dropped.some((id) => key.endsWith(`:${id}`))) input.warmed.delete(key);
  for (const entry of routed) {
    if (input.warmed.has(releaseKey({ workspaceId: entry.workspaceId, id: entry.releaseId })))
      continue;
    const release = await input.releases.getRelease(entry.workspaceId, entry.releaseId);
    if (release) input.requestWarm(release);
  }
}
