import {
  Cap,
  MULAW_8K,
  type EngineEvent,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import { duplexFromLegacy } from '../../plugin-kit/src/duplex-shims.ts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { createNativeVoiceEngineV2Plugin, NativeEngineV2Adapter } from './engine-v2-adapter.ts';
import { FakeMedia } from './production-media-fixtures.ts';
import { BoundedSpeechScheduler } from './scheduler.ts';
import { createSpeechSchedulerPlugin } from './plugins.ts';
import { createStreamingMediaSpeechOutputPlugin } from './production-plugins.ts';
import { VOICE_SERVICE_KEYS } from './types.ts';

describe('native v2 engine adapter', () => {
  it('composes the real manifest and emits agent, interrupt, voicemail and end events', async () => {
    const legacyMedia = new FakeMedia();
    const media = duplexFromLegacy(legacyMedia, MULAW_8K, 'carrier-played');
    const scheduler = new BoundedSpeechScheduler({
      play: async () => ({ state: 'completed', evidence: 'confirmed' }),
      interrupt: async () => undefined,
    });
    const host = definePlugin(
      {
        id: '@fixture/native-host',
        version: '1.0.0',
        contractVersion: 1,
        scope: 'session',
        provides: [Cap.behavior, Cap.media, VOICE_SERVICE_KEYS.scheduler],
        requires: [],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(Cap.behavior, { respond: async () => 'Hello' });
        ctx.provide(Cap.media, media);
        ctx.provide(VOICE_SERVICE_KEYS.scheduler, scheduler);
      },
    );
    const native = createNativeVoiceEngineV2Plugin();
    const composition = await compose(
      [
        { id: host.manifest.id },
        {
          id: native.manifest.id,
          config: {
            session: {
              mode: 'announcement',
              language: 'en-US',
              inputEnabled: false,
              variables: {},
              maxCallSeconds: 60,
              acknowledgements: [],
            },
            engine: {},
          },
        },
      ],
      [
        host,
        native,
        createSpeechSchedulerPlugin(),
        createStreamingMediaSpeechOutputPlugin({ source: 'v2' }),
      ],
    );
    try {
      const engine = composition.ctx.get(Cap.engine) as VoiceSessionEngine & NativeEngineV2Adapter;
      const events: EngineEvent[] = [];
      engine.subscribe((event) => events.push(event));
      await engine.start();
      await scheduler.speak('Hello');
      engine.interrupted('dtmf');
      const outcome = await engine.dispose('voicemail');
      expect(outcome).toEqual({ reason: 'voicemail', outcome: 'voicemail' });
      expect(legacyMedia.closes).toContain('voicemail');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'agent.transcript',
          text: 'Hello',
          state: 'generated',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'agent.transcript',
          text: 'Hello',
          state: 'played',
        }),
      );
      expect(events).toContainEqual({ type: 'interrupt', reason: 'dtmf' });
      expect(events).toContainEqual({ type: 'voicemail', result: 'machine' });
      expect(events).toContainEqual({ type: 'end', reason: 'voicemail' });
    } finally {
      await composition.dispose();
    }
  });
});
