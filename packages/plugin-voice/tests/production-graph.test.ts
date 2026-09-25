import {
  Cap,
  type EngineEvent,
  type SpeechReceipt,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { createScriptedTts } from '../../conformance/src/drivers/scripted-speech.ts';
import { plugins } from '../src/index.ts';
import { STREAMING_VOICE_PLUGIN_IDS } from '../src/production-plugins.ts';
import { VOICE_PLUGIN_IDS } from '../src/types.ts';

describe('native production graph', () => {
  it('composes its companions, filters speech, and speaks only after media acceptance', async () => {
    const carrier = createFakeCarrier();
    const tts = createScriptedTts();
    let completed = false;
    const host = definePlugin(
      {
        id: '@fixture/native-host',
        version: '1.0.0',
        contractVersion: 1,
        scope: 'session',
        requires: [],
        provides: [Cap.behavior, Cap.media, Cap.tts, Cap.clock, Cap.usage, Cap.transcripts],
        configSchema: { type: 'object', additionalProperties: false },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(Cap.behavior, {
          respond: async () => '**Hello** https://example.com',
          onPlayback: () => {
            completed = true;
          },
          isComplete: () => completed,
        });
        ctx.provide(Cap.media, carrier.duplex);
        ctx.provide(Cap.tts, tts);
        ctx.provide(Cap.clock, {
          now: Date.now,
          setTimeout(fn: () => void, ms: number) {
            const timer = setTimeout(fn, ms);
            return () => clearTimeout(timer);
          },
        });
        ctx.provide(Cap.usage, () => undefined);
        ctx.provide(Cap.transcripts, () => undefined);
      },
    );
    const rows = [
      { id: host.manifest.id },
      { id: VOICE_PLUGIN_IDS.scheduler },
      { id: STREAMING_VOICE_PLUGIN_IDS.mediaOutput, config: { markTimeoutMs: 1000 } },
      { id: '@winsendotai/ovo-text-filter-markdown' },
      { id: '@winsendotai/ovo-text-filter-url' },
      {
        id: STREAMING_VOICE_PLUGIN_IDS.sessionEngine,
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
    ];
    const composition = await compose(rows, [host, ...plugins]);
    try {
      const engine = composition.ctx.get(Cap.engine) as VoiceSessionEngine;
      const timings: Extract<EngineEvent, { type: 'timing' }>[] = [];
      engine.subscribe((event) => {
        if (event.type === 'timing') timings.push(event);
      });
      expect(engine.constructor.name).toBe('NativeVoiceSessionEngine');
      expect(composition.ctx.get(Cap.speech)).toBe(composition.ctx.get(Cap.scheduler));
      await engine.start();
      expect(await engine.ended).toEqual({ reason: 'behavior_completed', outcome: 'completed' });
      expect(
        (
          engine as unknown as {
            speechEvents: { segmentTurns: Map<string, string> };
          }
        ).speechEvents.segmentTurns.size,
      ).toBe(0);
      expect(tts.texts).toEqual(['Hello example dot com']);
      const firstAudio = carrier.log.findIndex((event) => event.type === 'audio');
      const firstClear = carrier.log.findIndex((event) => event.type === 'clear');
      expect(firstAudio).toBeGreaterThanOrEqual(0);
      expect(firstClear === -1 || firstClear > firstAudio).toBe(true);
      const keys = timings.map((event) => event.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'turn_decision',
          'behavior_first_segment',
          'text_aggregation',
          'tts_ttfb',
          'carrier_first_audio',
          'playout_ack',
        ]),
      );
      expect(timings.every((event) => event.turnId && event.ms !== undefined)).toBe(true);
      const first = timings[0]!;
      const last = timings.at(-1)!;
      expect(timings.reduce((sum, event) => sum + event.ms!, 0)).toBe(
        last.atMs - (first.atMs - first.ms!),
      );
    } finally {
      await composition.dispose();
    }
  });

  it('applies engine-row buffer and mark limits to the empty output companion row', async () => {
    const carrier = createFakeCarrier({ playback: 'manual' });
    const tts = createScriptedTts({ chunkMs: 100 });
    let playback: SpeechReceipt | undefined;
    const host = definePlugin(
      {
        id: '@fixture/engine-config-host',
        version: '1.0.0',
        contractVersion: 1,
        scope: 'session',
        requires: [],
        provides: [Cap.behavior, Cap.media, Cap.tts],
        configSchema: {},
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(Cap.behavior, {
          respond: async () => 'a long enough sentence',
          onPlayback: (receipt: SpeechReceipt) => {
            playback = receipt;
          },
          isComplete: () => Boolean(playback),
        });
        ctx.provide(Cap.media, carrier.duplex);
        ctx.provide(Cap.tts, tts);
      },
    );
    const composition = await compose(
      [
        { id: host.manifest.id },
        { id: VOICE_PLUGIN_IDS.scheduler },
        { id: STREAMING_VOICE_PLUGIN_IDS.mediaOutput, config: {} },
        {
          id: STREAMING_VOICE_PLUGIN_IDS.sessionEngine,
          config: {
            session: {
              mode: 'announcement',
              language: 'en-US',
              inputEnabled: false,
              variables: {},
              maxCallSeconds: 60,
              acknowledgements: [],
            },
            engine: { maxPrefetchBytes: 100, markTimeoutMs: 25 },
          },
        },
      ],
      [host, ...plugins],
    );
    const engine = composition.ctx.get(Cap.engine) as VoiceSessionEngine;
    try {
      await engine.start();
      const outcome = await Promise.race([
        engine.ended,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('engine-row mark timeout was not applied')), 500),
        ),
      ]);
      expect(outcome.reason).toBe('behavior_completed');
      expect(playback?.evidence).toBe('estimated');
      const audio = carrier.log.filter((event) => event.type === 'audio');
      expect(audio.length).toBeGreaterThan(1);
      expect(Math.max(...audio.map((event) => event.bytes))).toBeLessThanOrEqual(100);
    } finally {
      await engine.dispose('drain');
      await composition.dispose();
    }
  });
});
