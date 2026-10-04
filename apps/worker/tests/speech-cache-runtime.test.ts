import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { WorkerSpeechCacheRuntime, approvedSpeechPhrases } from '../src/speech-cache-runtime.ts';

describe('worker speech cache runtime', () => {
  it('derives only configured static phrases and the opted-in announcement', () => {
    const config = AgentConfig.parse({
      name: 'Cache policy',
      mode: 'announcement',
      message: 'Exact static announcement.',
      speechCache: { enabled: true, announcement: true },
      processing: { initial: 'Checking now.', progress: 'Still checking.' },
      tools: [
        {
          id: 'lookup',
          description: 'Lookup',
          connector: 'native',
          inputSchema: {},
          effect: 'read',
          processing: { initial: 'Tool starting.' },
        },
      ],
    });
    expect(approvedSpeechPhrases(config)).toEqual([
      { text: 'Checking now.', purpose: 'static-phrase' },
      { text: 'Still checking.', purpose: 'static-phrase' },
      { text: 'Tool starting.', purpose: 'static-phrase' },
      { text: 'Exact static announcement.', purpose: 'announcement' },
    ]);
    expect(
      approvedSpeechPhrases(
        AgentConfig.parse({ name: 'No cache', mode: 'announcement', message: 'Hi' }),
      ),
    ).toEqual([]);
  });

  it('keeps the process cache bounded and clears it on close', () => {
    const runtime = new WorkerSpeechCacheRuntime({ maxEntries: 1, maxBytes: 4, maxEntryBytes: 4 });
    runtime.cache.set('a', 'workspace-a', Uint8Array.of(1));
    runtime.cache.set('b', 'workspace-a', Uint8Array.of(2));
    expect(runtime.cache.stats).toMatchObject({ entries: 1, bytes: 1 });
    runtime.close();
    expect(runtime.cache.stats).toMatchObject({ entries: 0, bytes: 0 });
  });
});
