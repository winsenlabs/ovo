import {
  MULAW_8K,
  PCM16_24K,
  type NetFixtureStep,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { RumikTtsError } from '../src/errors.ts';
import {
  FIXTURE_BINDING,
  FIXTURE_DESCRIPTION,
  FIXTURE_KEY,
  fixtureAudio,
  synthesisStep,
} from '../src/testing.ts';
import { RumikTts } from '../src/tts.ts';
import { drain, flush, httpScript, recordingLogger, refusal, settle, ttsInput } from './support.ts';

const TEXT = 'Aapka agla EMI paanch tareekh ko due hai.';
const HTTP = { ...FIXTURE_BINDING, transport: 'http' as const };

/** One `POST /v1/tts` answered with `reply` (an error, or a 200 from synthesisStep). */
function answered(reply: ReturnType<typeof refusal>): NetFixtureStep {
  const step = synthesisStep(TEXT, MULAW_8K, new Uint8Array(0)) as NetFixtureStep & {
    reply: unknown;
  };
  return { ...step, reply } as NetFixtureStep;
}

const ok = () => synthesisStep(TEXT, MULAW_8K, fixtureAudio(MULAW_8K, TEXT));
const posts = (net: ReturnType<typeof createFixtureNet>) =>
  net.log.filter((entry) => entry.kind === 'http').length;

describe('R5: POST /v1/tts', () => {
  it('sends the model, audio_format and synthesis fields with the key, and logs the cost header', async () => {
    const audio = fixtureAudio(PCM16_24K, TEXT);
    const net = createFixtureNet([
      httpScript([
        synthesisStep(TEXT, PCM16_24K, audio, {
          'x-usage-cost-nanos': '23500000',
          'x-audio-duration-ms': '2310',
        }),
      ]),
    ]);
    const logger = recordingLogger();
    const usage: UsageMeter[] = [];
    const tts = new RumikTts(net, FIXTURE_KEY, { ...HTTP, speaker: 'ira' }, undefined, logger);
    const chunks: Uint8Array[] = [];
    for await (const chunk of tts.synthesize(
      ttsInput(usage, { text: TEXT, format: PCM16_24K, voice: 'Siya' }),
    ))
      chunks.push(chunk);
    // The fixture splits the body mid-sample; every chunk is still whole samples.
    expect(chunks.every((chunk) => chunk.byteLength % 2 === 0)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(audio));
    expect(JSON.parse(String(net.log[0]!.data))).toEqual({
      model: 'mulberry',
      audio_format: 'pcm',
      text: TEXT,
      description: FIXTURE_DESCRIPTION,
      speaker: 'siya',
      normalization: false,
    });
    expect(logger.lines).toContainEqual({
      level: 'info',
      event: 'rumik.tts.http',
      fields: { requestId: 'rumik:call-1:1', usageCostNanos: 23500000, audioDurationMs: 2310 },
    });
    expect(usage).toEqual([
      expect.objectContaining({ state: 'estimated', requestId: 'rumik:call-1:1' }),
    ]);
    net.assertComplete();
  });

  it('retries 502 GENERATION_ERROR once, immediately', async () => {
    const net = createFixtureNet([httpScript([answered(refusal(502, 'GENERATION_ERROR')), ok()])]);
    const tts = new RumikTts(net, FIXTURE_KEY, HTTP);
    expect(await drain(tts.synthesize(ttsInput([], { text: TEXT })))).toHaveLength(
      fixtureAudio(MULAW_8K, TEXT).byteLength,
    );
    net.assertComplete();
  });

  it('gives up after a second 502, retryable, and meters nothing', async () => {
    const net = createFixtureNet([
      httpScript([
        answered(refusal(502, 'GENERATION_ERROR')),
        answered(refusal(502, 'GENERATION_ERROR')),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const result = await settle(
      new RumikTts(net, FIXTURE_KEY, HTTP).synthesize(ttsInput(usage, { text: TEXT })),
    );
    expect(result.error).toBeInstanceOf(RumikTtsError);
    expect(result.error).toMatchObject({ status: 502, code: 'GENERATION_ERROR', retryable: true });
    expect(posts(net)).toBe(2);
    expect(usage).toEqual([]);
    net.assertComplete();
  });

  it('retries 503 after 250 ms then 500 ms, and stops after the third', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        httpScript([
          answered(refusal(503, 'UNAVAILABLE')),
          answered(refusal(503, 'UNAVAILABLE')),
          ok(),
        ]),
      ],
      { clock },
    );
    const audio = drain(
      new RumikTts(net, FIXTURE_KEY, HTTP, clock).synthesize(ttsInput([], { text: TEXT })),
    );
    await flush();
    expect(posts(net)).toBe(1);
    await clock.advanceAsync(249);
    expect(posts(net)).toBe(1);
    await clock.advanceAsync(1);
    expect(posts(net)).toBe(2);
    await clock.advanceAsync(499);
    expect(posts(net)).toBe(2);
    await clock.advanceAsync(1);
    expect(await audio).toHaveLength(fixtureAudio(MULAW_8K, TEXT).byteLength);
    net.assertComplete();

    const failing = createFixtureNet(
      [httpScript([1, 2, 3].map(() => answered(refusal(503, 'UNAVAILABLE'))))],
      { clock },
    );
    const result = settle(
      new RumikTts(failing, FIXTURE_KEY, HTTP, clock).synthesize(ttsInput([], { text: TEXT })),
    );
    await clock.advanceAsync(750);
    expect(await result).toMatchObject({ error: { status: 503, retryable: true } });
    expect(posts(failing)).toBe(3);
    failing.assertComplete();
  });

  it('maps 402 to a non-retryable balance error, never retried', async () => {
    for (const code of ['insufficient_balance', 'access_blocked']) {
      const net = createFixtureNet([httpScript([answered(refusal(402, code))])]);
      const result = await settle(
        new RumikTts(net, FIXTURE_KEY, HTTP).synthesize(ttsInput([], { text: TEXT })),
      );
      expect(result.error).toMatchObject({ status: 402, code, retryable: false });
      net.assertComplete();
    }
  });

  it('maps 429 to a retryable error with its code and Retry-After, never retried here', async () => {
    const full = createFixtureNet([
      httpScript([answered(refusal(429, 'concurrency_limit_exceeded'))]),
    ]);
    const busy = await settle(
      new RumikTts(full, FIXTURE_KEY, HTTP).synthesize(ttsInput([], { text: TEXT })),
    );
    expect(busy.error).toMatchObject({
      status: 429,
      code: 'concurrency_limit_exceeded',
      retryable: true,
      retryAfterMs: undefined,
    });
    full.assertComplete();

    const limited = createFixtureNet([
      httpScript([answered(refusal(429, 'rate_limited', { 'retry-after': '7' }))]),
    ]);
    const rate = await settle(
      new RumikTts(limited, FIXTURE_KEY, HTTP).synthesize(ttsInput([], { text: TEXT })),
    );
    expect(rate.error).toMatchObject({ code: 'rate_limited', retryAfterMs: 7000 });
    expect(posts(limited)).toBe(1);
    limited.assertComplete();
  });

  it('never puts the provider error message in the thrown error', async () => {
    const net = createFixtureNet([
      httpScript([
        answered({
          status: 422,
          headers: {},
          body: JSON.stringify({ error: 'text: secret customer words', code: 'VALIDATION_ERROR' }),
        }),
      ]),
    ]);
    const result = await settle(
      new RumikTts(net, FIXTURE_KEY, HTTP).synthesize(ttsInput([], { text: TEXT })),
    );
    expect(String(result.error)).not.toContain('secret');
    expect(result.error).toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    net.assertComplete();
  });
});
