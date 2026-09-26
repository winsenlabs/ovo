import { describe, expect, it } from 'vitest';
import { MULAW_8K, type UsageMeter } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { DeepgramStt } from '../src/deepgram.ts';

describe('Deepgram request usage correlation', () => {
  it.each(['abrupt close', 'Metadata without request_id'])(
    'keeps two same-session streams distinct after %s',
    async (scenario) => {
      const sizes = [4000, 8000];
      const scripts: Parameters<typeof createFixtureNet>[0] = sizes.map((size) => {
        const steps: Parameters<typeof createFixtureNet>[0][number]['steps'] = [
          { expect: 'ws-open', url: /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/ },
          { expect: 'ws-send', match: 'binary' },
        ];
        if (scenario === 'abrupt close') steps.push({ close: { code: 1011 } });
        else {
          steps.push(
            { expect: 'ws-send', match: 'json', where: { type: 'CloseStream' } },
            { send: JSON.stringify({ type: 'Metadata', duration: size / 8000 }) },
          );
        }
        return {
          host: 'api.deepgram.com',
          source: 'https://developers.deepgram.com/reference/speech-to-text/listen-streaming',
          retrieved: '2026-09-26',
          steps,
        };
      });
      const net = createFixtureNet(scripts);
      const clock = new FakeClock();
      const provider = new DeepgramStt(net, 'fixture-key', { model: 'nova-3' }, clock);
      const usage: UsageMeter[] = [];
      for (const size of sizes) {
        const stream = await provider.start({
          sessionId: 'same-call',
          format: MULAW_8K,
          language: 'en',
          signal: new AbortController().signal,
          onEvent: () => undefined,
          onUsage: (meter) => usage.push(meter),
        });
        await stream.write(new Uint8Array(size));
        if (scenario === 'abrupt close')
          await expect(stream.finish()).rejects.toThrow('before Metadata');
        else await stream.finish();
      }
      expect(usage).toMatchObject([
        { quantity: '0.5', unit: 'audio_seconds' },
        { quantity: '1', unit: 'audio_seconds' },
      ]);
      expect(new Set(usage.map((meter) => meter.requestId)).size).toBe(2);
      expect(clock.pendingTimers).toBe(0);
      net.assertComplete();
    },
  );
});
