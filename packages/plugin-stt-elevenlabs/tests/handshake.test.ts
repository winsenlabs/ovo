import { MULAW_8K, PCM16_8K, type NetFixtureScript } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { elevenLabsSttPlugin } from '../src/index.ts';
import { scribeCapabilitiesFor } from '../src/capabilities.ts';
import { DEFAULT_CONNECT_TIMEOUT_MS, ElevenLabsStt, scribeUrl } from '../src/provider.ts';
import { RETRIEVED, SOURCE, sessionStarted } from '../src/testing.ts';

function socket(host: string, steps: NetFixtureScript['steps'] = []): NetFixtureScript {
  const url = new RegExp(`^wss://${host.replaceAll('.', '\\.')}/v1/speech-to-text/realtime\\?`);
  return {
    host,
    source: SOURCE,
    retrieved: RETRIEVED,
    steps: [{ expect: 'ws-open', url, headers: { 'xi-api-key': 'fixture-key' } }, ...steps],
  };
}

function input(usage: unknown[] = [], language = 'en-IN') {
  return {
    sessionId: 'scribe-handshake',
    format: MULAW_8K,
    language,
    signal: new AbortController().signal,
    onEvent: () => undefined,
    onUsage: (meter: unknown) => usage.push(meter),
  };
}

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('Scribe handshake URL', () => {
  it('opens a manual-commit mu-law session with auto language detection by default', () => {
    const url = new URL(scribeUrl({}, MULAW_8K, 'hi-IN'));
    expect(url.origin + url.pathname).toBe('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model_id: 'scribe_v2_realtime',
      audio_format: 'ulaw_8000',
      commit_strategy: 'manual',
    });
  });

  it('pins the session language, region, keyterms and provider VAD settings when asked', () => {
    const url = new URL(
      scribeUrl(
        {
          region: 'in',
          languageMode: 'session',
          commitStrategy: 'vad',
          vadSilenceThresholdSecs: 0.4,
          minSilenceDurationMs: 250,
          keyterms: ['CreditMantri', 'EMI'],
          noVerbatim: true,
          enableLogging: false,
        },
        PCM16_8K,
        'ta-IN',
      ),
    );
    expect(url.host).toBe('api.in.residency.elevenlabs.io');
    expect(url.searchParams.get('audio_format')).toBe('pcm_8000');
    expect(url.searchParams.get('language_code')).toBe('ta');
    expect(url.searchParams.get('commit_strategy')).toBe('vad');
    expect(url.searchParams.get('vad_silence_threshold_secs')).toBe('0.4');
    expect(url.searchParams.get('min_silence_duration_ms')).toBe('250');
    expect(url.searchParams.has('vad_threshold')).toBe(false);
    expect(url.searchParams.getAll('keyterms')).toEqual(['CreditMantri', 'EMI']);
    expect(url.searchParams.get('no_verbatim')).toBe('true');
    expect(url.searchParams.get('enable_logging')).toBe('false');
  });

  it('never sends provider VAD settings with a manual commit', () => {
    const url = new URL(scribeUrl({ vadSilenceThresholdSecs: 0.4 }, MULAW_8K, 'en'));
    expect(url.searchParams.has('vad_silence_threshold_secs')).toBe(false);
  });
});

describe('Scribe capabilities and manifest', () => {
  it('declares provider end-of-turn only when the provider commits', () => {
    expect(scribeCapabilitiesFor({}).turnSignals).toEqual([]);
    expect(scribeCapabilitiesFor({ commitStrategy: 'vad' }).turnSignals).toEqual(['end-of-turn']);
    expect(scribeCapabilitiesFor({}).forceEndpoint).toBe(true);
    expect(scribeCapabilitiesFor({}).inputFormats[0]).toEqual(MULAW_8K);
  });

  it('lists Indian languages for the binding-aware compat check', () => {
    const capabilities = (elevenLabsSttPlugin.manifest as unknown as { capabilities: unknown })
      .capabilities as {
      bindingLanguages: { by: Record<string, readonly string[]> };
    };
    for (const code of ['en', 'hi', 'ta', 'te', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'or'])
      expect(capabilities.bindingLanguages.by.scribe_v2_realtime).toContain(code);
  });

  it('accepts connect deadlines up to 15 s and rejects keyterms the provider would refuse', () => {
    const registry = new PluginRegistry([elevenLabsSttPlugin]);
    const id = elevenLabsSttPlugin.manifest.id;
    expect(registry.validateBinding(id, { connectTimeoutMs: 15_000 }).ok).toBe(true);
    expect(registry.validateBinding(id, { connectTimeoutMs: 15_001 }).ok).toBe(false);
    expect(registry.validateBinding(id, { keyterms: ['x'.repeat(21)] }).ok).toBe(false);
    expect(registry.validateBinding(id, { region: 'in', fallbackRegion: 'default' }).ok).toBe(true);
  });

  it('refuses a language Scribe does not transcribe before opening a socket', async () => {
    const net = createFixtureNet([]);
    await expect(new ElevenLabsStt(net, 'fixture-key').start(input([], 'tlh'))).rejects.toThrow(
      /does not support tlh/,
    );
    expect(net.log).toEqual([]);
  });
});

describe('Scribe handshake deadline and region failover', () => {
  it('waits the 6 s default, then retries once in the fallback region', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        // The primary accepts the socket and never starts the session.
        socket('api.elevenlabs.io'),
        socket('api.us.elevenlabs.io', [{ delayMs: 400 }, { send: sessionStarted('scribe-us') }]),
      ],
      { clock },
    );
    const usage: unknown[] = [];
    const stt = new ElevenLabsStt(net, 'fixture-key', { fallbackRegion: 'us' }, clock);
    let ready = false;
    const starting = stt.start(input(usage)).then((session) => {
      ready = true;
      return session;
    });
    await clock.advanceAsync(DEFAULT_CONNECT_TIMEOUT_MS - 1);
    expect(ready).toBe(false);
    expect(net.log.filter((entry) => entry.kind === 'ws-open')).toHaveLength(1);
    await clock.advanceAsync(1);
    expect(net.log.filter((entry) => entry.kind === 'ws-open')).toHaveLength(2);
    await clock.advanceAsync(400);
    const session = await starting;
    expect(clock.now()).toBe(6_400);
    // The abandoned attempt is metered under its own request ID.
    expect(usage).toMatchObject([
      { state: 'estimated', requestId: 'elevenlabs:scribe-handshake:1' },
    ]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('stt_connect_retry'));
    await session.cancel('done');
    net.assertComplete();
  });

  it('fails with a typed connect-timeout once both attempts miss session_started', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet([socket('api.elevenlabs.io'), socket('api.elevenlabs.io')], {
      clock,
    });
    const stt = new ElevenLabsStt(net, 'fixture-key', { connectTimeoutMs: 2_000 }, clock);
    const starting = stt.start(input());
    const settled = expect(starting).rejects.toMatchObject({
      code: 'connect-timeout',
      retryable: true,
    });
    await clock.advanceAsync(4_000);
    await settled;
  });
});
