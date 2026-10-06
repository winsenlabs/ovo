import { MULAW_8K, PCM16_16K, type UsageMeter } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { multiStreamUrl } from '../src/binding.ts';
import { MAX_CONTEXTS } from '../src/connection.ts';
import { ElevenLabsTts } from '../src/tts.ts';
import { socketOpen } from '../src/testing.ts';
import { audioFrame, drain, finalFrame, sent, ttsInput, utterance, wsScript } from './support.ts';

const wsOpens = (net: ReturnType<typeof createFixtureNet>) =>
  net.log.filter((entry) => entry.kind === 'ws-open');
const outFrames = (net: ReturnType<typeof createFixtureNet>) =>
  net.log
    .filter((entry) => entry.kind === 'ws-out')
    .map((entry) => JSON.parse(String(entry.data)) as Record<string, unknown>);

describe('ElevenLabs multi-stream-input wire format', () => {
  it('builds the documented socket URL from the binding', () => {
    const url = new URL(
      multiStreamUrl(
        {
          model: 'eleven_turbo_v2_5',
          languageCode: 'hi',
          seed: 42,
          applyTextNormalization: 'off',
          enableLogging: false,
          region: 'in-residency',
          inactivityTimeoutS: 60,
          autoMode: false,
        },
        'voice-x',
        MULAW_8K,
      ),
    );
    expect(url.origin + url.pathname).toBe(
      'wss://api.in.residency.elevenlabs.io/v1/text-to-speech/voice-x/multi-stream-input',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model_id: 'eleven_turbo_v2_5',
      output_format: 'ulaw_8000',
      inactivity_timeout: '60',
      auto_mode: 'false',
      language_code: 'hi',
      apply_text_normalization: 'off',
      seed: '42',
      enable_logging: 'false',
    });
    const defaults = new URL(multiStreamUrl({}, 'ZUrEGyu8GFMwnHbvLhv2', PCM16_16K));
    expect(defaults.searchParams.get('model_id')).toBe('eleven_flash_v2_5');
    expect(defaults.searchParams.get('output_format')).toBe('pcm_16000');
    expect(defaults.searchParams.get('inactivity_timeout')).toBe('180');
    expect(defaults.searchParams.get('auto_mode')).toBe('true');
  });

  it('streams one context: voice settings on the first frame only, flush then close_context, native μ-law', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K, 'ZUrEGyu8GFMwnHbvLhv2'),
        sent('ovo-1', {
          text: 'Namaste, ',
          voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1 },
          pronunciation_dictionary_locators: [
            { pronunciation_dictionary_id: 'lenders', version_id: 'v3' },
          ],
        }),
        sent('ovo-1', { text: 'this is Monika.' }),
        sent('ovo-1', { text: '', flush: true }),
        sent('ovo-1', { close_context: true }),
        { send: audioFrame('ovo-1', [1, 2, 3]) },
        { send: audioFrame('ovo-1', [4, 5]) },
        { send: finalFrame('ovo-1') },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(net, 'fixture-key', {
      pronunciationDictionaries: [{ id: 'lenders', versionId: 'v3' }],
    });
    const context = await tts.open(ttsInput(usage));
    context.push('Namaste, ');
    context.push('this is Monika.');
    context.flush();
    expect(await drain(context.audio)).toEqual([1, 2, 3, 4, 5]);
    await context.close();
    expect(outFrames(net)[1]).not.toHaveProperty('voice_settings');
    expect(usage).toEqual([
      expect.objectContaining({
        provider: 'elevenlabs',
        operation: 'tts',
        unit: 'characters',
        quantity: '24',
        state: 'estimated',
        requestId: 'elevenlabs:call-1:1',
      }),
    ]);
    net.assertComplete();
  });

  it('pools every utterance of a session on one socket and numbers the contexts', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        ...utterance('ovo-1', 'One.', [audioFrame('ovo-1', [1]), finalFrame('ovo-1')]),
        ...utterance('ovo-2', 'Two.', [audioFrame('ovo-2', [2]), finalFrame('ovo-2')]),
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const heard: number[][] = [];
    for (const text of ['One.', 'Two.']) {
      const chunks: number[] = [];
      for await (const chunk of tts.synthesize({ ...ttsInput(), text })) chunks.push(...chunk);
      heard.push(chunks);
    }
    expect(heard).toEqual([[1], [2]]);
    expect(wsOpens(net)).toHaveLength(1);
    net.assertComplete();
  });

  it('routes the interleaved audio of two open contexts by contextId', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: 'First sentence.' }),
        sent('ovo-1', { text: '', flush: true }),
        sent('ovo-1', { close_context: true }),
        sent('ovo-2', { text: 'Second sentence.' }),
        sent('ovo-2', { text: '', flush: true }),
        sent('ovo-2', { close_context: true }),
        { send: audioFrame('ovo-2', [20]) },
        { send: audioFrame('ovo-1', [10]) },
        { send: audioFrame('ovo-1', [11]) },
        { send: finalFrame('ovo-1') },
        { send: audioFrame('ovo-2', [21]) },
        { send: finalFrame('ovo-2') },
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const first = await tts.open(ttsInput());
    first.push('First sentence.');
    first.flush();
    const second = await tts.open(ttsInput());
    second.push('Second sentence.');
    second.flush();
    expect(await drain(first.audio)).toEqual([10, 11]);
    expect(await drain(second.audio)).toEqual([20, 21]);
    await Promise.all([first.close(), second.close()]);
    net.assertComplete();
  });

  it('a barge-in closes only its own context and late audio for it is ignored', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: 'A long answer' }),
        { send: audioFrame('ovo-1', [1]) },
        sent('ovo-1', { close_context: true }),
        { send: audioFrame('ovo-1', [2]) },
        { send: finalFrame('ovo-1') },
        ...utterance('ovo-2', 'Sorry, go ahead.', [audioFrame('ovo-2', [9]), finalFrame('ovo-2')]),
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const usage: UsageMeter[] = [];
    const abort = new AbortController();
    const talking = await tts.open(ttsInput(usage, { signal: abort.signal }));
    talking.push('A long answer');
    const iterator = talking.audio[Symbol.asyncIterator]();
    expect([...(await iterator.next()).value!]).toEqual([1]);
    abort.abort(new DOMException('caller spoke', 'AbortError'));
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    await talking.close();
    expect(usage).toMatchObject([{ quantity: '13', requestId: 'elevenlabs:call-1:1' }]);
    const reply = await tts.open(ttsInput());
    reply.push('Sorry, go ahead.');
    reply.flush();
    expect(await drain(reply.audio)).toEqual([9]);
    await reply.close();
    expect(wsOpens(net)).toHaveLength(1);
    expect(outFrames(net).filter((frame) => frame.close_context)).toHaveLength(2);
    net.assertComplete();
  });

  it('reopens lazily after the provider closes an idle socket', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        ...utterance('ovo-1', 'Before.', [audioFrame('ovo-1', [1]), finalFrame('ovo-1')]),
        { close: { code: 1000, reason: 'inactivity' } },
        socketOpen(MULAW_8K),
        ...utterance('ovo-2', 'After.', [audioFrame('ovo-2', [2]), finalFrame('ovo-2')]),
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    for (const [text, expected] of [
      ['Before.', [1]],
      ['After.', [2]],
    ] as const) {
      const chunks: number[] = [];
      for await (const chunk of tts.synthesize({ ...ttsInput(), text })) chunks.push(...chunk);
      expect(chunks).toEqual(expected);
      await Promise.resolve();
    }
    expect(wsOpens(net)).toHaveLength(2);
    net.assertComplete();
  });

  it('fails only the named context on a context error frame', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: 'Bad.' }),
        sent('ovo-1', { text: '', flush: true }),
        sent('ovo-1', { close_context: true }),
        sent('ovo-2', { text: 'Good.' }),
        sent('ovo-2', { text: '', flush: true }),
        sent('ovo-2', { close_context: true }),
        {
          send: JSON.stringify({
            error: 'invalid_request',
            message: 'bad text',
            contextId: 'ovo-1',
          }),
        },
        { send: audioFrame('ovo-2', [7]) },
        { send: finalFrame('ovo-2') },
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const bad = await tts.open(ttsInput());
    bad.push('Bad.');
    bad.flush();
    const good = await tts.open(ttsInput());
    good.push('Good.');
    good.flush();
    await expect(drain(bad.audio)).rejects.toMatchObject({
      name: 'ElevenLabsTtsError',
      message: 'ElevenLabs TTS error: bad text',
      retryable: false,
    });
    expect(await drain(good.audio)).toEqual([7]);
    await Promise.all([bad.close(), good.close()]);
    net.assertComplete();
  });

  it(`holds a sixth concurrent context until one of the ${MAX_CONTEXTS} slots frees`, async () => {
    const steps = [socketOpen(MULAW_8K)];
    for (let n = 1; n <= MAX_CONTEXTS; n += 1) steps.push(sent(`ovo-${n}`, { text: `Line ${n}.` }));
    steps.push(sent('ovo-1', { text: '', flush: true }), sent('ovo-1', { close_context: true }));
    steps.push({ send: finalFrame('ovo-1') }, sent('ovo-6', { text: 'Line 6.' }));
    const net = createFixtureNet([wsScript(steps)]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const open = [];
    for (let n = 1; n <= MAX_CONTEXTS; n += 1) {
      const context = await tts.open(ttsInput());
      context.push(`Line ${n}.`);
      open.push(context);
    }
    let sixth: Awaited<ReturnType<typeof tts.open>> | undefined;
    const waiting = tts.open(ttsInput()).then((context) => (sixth = context));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sixth).toBeUndefined();
    open[0]!.flush();
    await drain(open[0]!.audio);
    await waiting;
    sixth!.push('Line 6.');
    expect(net.pending()).toEqual([]);
  });

  it('closes the pooled socket on dispose and refuses new utterances', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        ...utterance('ovo-1', 'Bye.', [audioFrame('ovo-1', [1]), finalFrame('ovo-1')]),
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    await drain(tts.synthesize({ ...ttsInput(), text: 'Bye.' }));
    tts.dispose();
    await Promise.resolve();
    expect(net.log.at(-1)).toMatchObject({ kind: 'ws-close', data: '1000 ' });
    await expect(tts.open(ttsInput())).rejects.toThrow('disposed');
    net.assertComplete();
  });

  it('opens the socket early on warm() so the first utterance skips the handshake', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        wsScript([
          socketOpen(MULAW_8K),
          ...utterance('ovo-1', 'Hello.', [audioFrame('ovo-1', [3]), finalFrame('ovo-1')]),
        ]),
      ],
      { clock },
    );
    const tts = new ElevenLabsTts(net, 'fixture-key', {}, clock);
    await tts.warm({ format: MULAW_8K });
    expect(wsOpens(net)).toHaveLength(1);
    expect(await drain(tts.synthesize({ ...ttsInput(), text: 'Hello.' }))).toEqual([3]);
    expect(wsOpens(net)).toHaveLength(1);
    net.assertComplete();
  });
});
