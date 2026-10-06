import { Cap } from '@winsendotai/ovo-contracts';
import { createLogger, type NodeNet } from '@winsendotai/ovo-plugin-kit';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { prewarmJobProviders, selectionOrigins } from '../src/provider-prewarm.ts';

// LAT-8: the job's provider hosts are warmed while the phone rings, so the first turn's decision,
// LLM and TTS requests find a pooled TLS connection instead of paying DNS+TCP+TLS.

const plugin = (id: string, egressHosts: string[]) =>
  definePlugin(
    {
      id,
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'infra',
      provides: [Cap.inference],
      requires: [],
      runtime: { egressHosts, modelLicences: [] },
    },
    () => undefined,
  );

const registry = new PluginRegistry([
  plugin('llm', ['api.llm.test']),
  plugin('tts', ['api.tts.test', '*.tts.test']),
  plugin('stt', ['api.llm.test']),
]);

const release = {
  id: 'rel-1',
  workspaceId: 'ws',
  selections: {
    llm: { pluginId: 'llm', version: '1.0.0' },
    tts: { pluginId: 'tts', version: '1.0.0' },
    stt: { pluginId: 'stt', version: '1.0.0' },
  },
} as unknown as ReleaseRecord;

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({}, { level: 'debug', sink: (line) => lines.push(JSON.parse(line)) });
  return { lines, log };
}

function fakeNet(prewarm: NodeNet['prewarm']): NodeNet {
  return { prewarm } as unknown as NodeNet;
}

const stores = (payload: Record<string, unknown> = { releaseId: 'rel-1' }) => ({
  store: { get: vi.fn(async () => ({ id: 'job-1', workspaceId: 'ws', payload }) as never) },
  control: { getRelease: vi.fn(async () => release) },
});

describe('provider pre-warm (LAT-8)', () => {
  it('lists each exact egress host of the selected plugins once, skipping wildcards', () => {
    expect(selectionOrigins(release.selections as never, registry)).toEqual([
      'https://api.llm.test',
      'https://api.tts.test',
    ]);
  });

  it('warms the release’s provider origins for a job and logs what each cost', async () => {
    const { lines, log } = capture();
    const prewarm = vi.fn<NodeNet['prewarm']>(async (origins) =>
      origins.map((origin) => ({ origin, ok: true, status: 404, elapsedMs: 12 })),
    );
    await prewarmJobProviders({
      jobId: 'job-1',
      net: fakeNet(prewarm),
      registry,
      log,
      ...stores(),
    });
    expect(prewarm).toHaveBeenCalledWith(['https://api.llm.test', 'https://api.tts.test'], {
      timeoutMs: 3_000,
    });
    expect(lines.find((line) => line.event === 'provider_prewarm')).toMatchObject({
      level: 'info',
      jobId: 'job-1',
      origins: [
        { origin: 'https://api.llm.test', ok: true, status: 404, elapsedMs: 12 },
        { origin: 'https://api.tts.test', ok: true, status: 404, elapsedMs: 12 },
      ],
    });
  });

  it('never throws: a failing lookup is a warning and the call goes on cold', async () => {
    const { lines, log } = capture();
    const prewarm = vi.fn<NodeNet['prewarm']>();
    await expect(
      prewarmJobProviders({
        jobId: 'job-1',
        net: fakeNet(prewarm),
        registry,
        log,
        store: {
          get: async () => {
            throw new Error('db down');
          },
        },
        control: { getRelease: vi.fn() },
      }),
    ).resolves.toBeUndefined();
    expect(prewarm).not.toHaveBeenCalled();
    expect(lines.find((line) => line.event === 'provider_prewarm_failed')).toMatchObject({
      level: 'warn',
      jobId: 'job-1',
      error: 'db down',
    });
  });

  it('does nothing for a net port without pre-warm or a job without a release', async () => {
    const { lines, log } = capture();
    const missing = stores({});
    await prewarmJobProviders({ jobId: 'job-1', net: undefined, registry, log, ...missing });
    expect(missing.store.get).not.toHaveBeenCalled();
    const prewarm = vi.fn<NodeNet['prewarm']>();
    await prewarmJobProviders({ jobId: 'job-1', net: fakeNet(prewarm), registry, log, ...missing });
    expect(missing.control.getRelease).not.toHaveBeenCalled();
    expect(prewarm).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});
