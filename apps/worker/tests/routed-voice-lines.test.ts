import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { describe, expect, it, vi } from 'vitest';
import { warmReleaseClips, withRoutedLines } from '../src/speech-cache-prerender.ts';
import { syncRoutedReleases, warmKey } from '../src/speech-cache-routed.ts';
import { sessionSpeechApprovals } from '../src/speech-cache-runtime.ts';
import { WorkerSpeechClipCache } from '../src/speech-cache-tiers.ts';
import { fixtureRelease, RecordingTts } from './speech-cache-harness.ts';

const release = fixtureRelease({ speechCache: { enabled: true }, message: 'Hello from sales.' });
const lines = ["I'm transferring your call now. Please stay on the line.", 'Shall I {{x}}?'];
const options = { concurrency: 2, attempts: 1, renderTimeoutMs: 5_000, backoffMs: 0 };

describe("a routing point's fixed lines for a release (transfer design 7.1, 7.11)", () => {
  it('joins the release inventory as scripted lines, never a templated one', () => {
    const inventory = withRoutedLines({ static: [], perCall: [] }, lines);
    expect(inventory.static).toEqual([{ text: lines[0], source: 'script' }]);
    const approvals = sessionSpeechApprovals(release, [], lines);
    expect(approvals).toContainEqual({ text: lines[0], purpose: 'scripted' });
    expect(approvals.map((phrase) => phrase.text)).not.toContain(lines[1]);
    expect(sessionSpeechApprovals(release, [])).not.toContainEqual({
      text: lines[0],
      purpose: 'scripted',
    });
  });

  it("are pre-rendered with the release's own lines", async () => {
    const tts = new RecordingTts();
    const cache = new WorkerSpeechClipCache();
    const signal = new AbortController().signal;
    const plain = await warmReleaseClips(
      { release, tts, filters: [], onUsage: () => undefined, signal },
      { cache, options },
    );
    const routed = await warmReleaseClips(
      { release, tts, filters: [], onUsage: () => undefined, signal, lines },
      { cache, options },
    );
    expect(routed.total).toBe(plain.total + 1);
    expect(tts.calls.map((call) => call.text)).toContain(lines[0]);
    expect(routed.inventorySha256).not.toBe(plain.inventorySha256);
  });

  it('warm a routed release with its lines, and again when its lines change', async () => {
    const records = new Map([[release.id, release]]);
    const requested: [string, readonly string[] | undefined][] = [];
    let listed: { workspaceId: string; releaseId: string; lines?: string[] }[] = [
      { workspaceId: release.workspaceId, releaseId: release.id, lines: [lines[0]!] },
    ];
    const warmed = new Set<string>();
    const sync = () =>
      syncRoutedReleases({
        queue: { routedReleases: vi.fn(async () => listed) },
        cache: new WorkerSpeechClipCache(),
        releases: { getRelease: async (_ws, id) => records.get(id) as ReleaseRecord },
        warmed,
        requestWarm: (record, routed) => {
          requested.push([record.id, routed]);
          warmed.add(warmKey(record, routed));
        },
      });
    await sync();
    await sync();
    expect(requested).toEqual([[release.id, [lines[0]]]]);
    listed = [{ ...listed[0]!, lines: ['A new announcement.'] }];
    await sync();
    expect(requested.at(-1)).toEqual([release.id, ['A new announcement.']]);
    expect(warmKey(release)).toBe(`${release.workspaceId}:${release.id}`);
    expect(warmKey(release, ['a'])).not.toBe(warmKey(release, ['b']));
  });
});
