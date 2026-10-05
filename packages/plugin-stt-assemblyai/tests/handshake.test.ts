import { MULAW_8K, type NetFixtureScript, type SttEvent } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assemblyAiPlugin } from '../src/index.ts';
import {
  AssemblyAiStt,
  assemblyAiCapabilitiesFor,
  assemblyAiLanguageCodes,
  assemblyAiUrl,
} from '../src/provider.ts';

const source = 'https://www.assemblyai.com/docs/streaming/message-sequence';

function begin(model = 'universal-streaming-english') {
  return JSON.stringify({
    type: 'Begin',
    id: 'aa-begin',
    expires_at: '2026-10-06T00:00:00Z',
    configuration: { model },
  });
}

function socket(host: string, steps: NetFixtureScript['steps'] = []): NetFixtureScript {
  const pattern = new RegExp(`^wss://${host.replaceAll('.', '\\.')}/v3/ws\\?`);
  return {
    host,
    source,
    retrieved: '2026-10-06',
    steps: [{ expect: 'ws-open', url: pattern }, ...steps],
  };
}

function input(language = 'en', usage: unknown[] = []) {
  return {
    sessionId: 'aa-handshake',
    format: MULAW_8K,
    language,
    signal: new AbortController().signal,
    onEvent: (_event: SttEvent) => undefined,
    onUsage: (meter: unknown) => usage.push(meter),
  };
}

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('AssemblyAI handshake deadline and region failover', () => {
  it('retries once in the fallback region when Begin misses the connect deadline', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        // The primary region accepts the socket and never sends Begin.
        socket('streaming.us.assemblyai.com'),
        socket('streaming.eu.assemblyai.com', [{ delayMs: 400 }, { send: begin() }]),
      ],
      { clock },
    );
    const usage: unknown[] = [];
    const stt = new AssemblyAiStt(
      net,
      'fixture-key',
      { region: 'us', fallbackRegion: 'eu', connectTimeoutMs: 3_000 },
      clock,
    );
    let ready = false;
    const starting = stt.start(input('en', usage)).then((session) => {
      ready = true;
      return session;
    });
    await clock.advanceAsync(2_999);
    expect(ready).toBe(false);
    await clock.advanceAsync(1);
    expect(net.log.filter((entry) => entry.kind === 'ws-open')).toHaveLength(2);
    await clock.advanceAsync(400);
    const session = await starting;
    expect(clock.now()).toBe(3_400);
    // The abandoned attempt is metered under its own request ID.
    expect(usage).toMatchObject([{ state: 'estimated', requestId: 'assemblyai:aa-handshake:1' }]);
    await session.cancel('done');
    net.assertComplete();
  });

  it('fails with a typed connect-timeout once both attempts miss Begin', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [socket('streaming.assemblyai.com'), socket('streaming.assemblyai.com')],
      { clock },
    );
    const starting = new AssemblyAiStt(net, 'fixture-key', {}, clock).start(input());
    const rejected = expect(starting).rejects.toMatchObject({
      name: 'AssemblyAiProviderError',
      code: 'connect-timeout',
      retryable: true,
    });
    await clock.advanceAsync(6_000);
    await rejected;
    net.assertComplete();
  });

  it('does not retry a refused key', async () => {
    const net = createFixtureNet([
      socket('streaming.assemblyai.com', [{ close: { code: 1008, reason: 'Unauthorized' } }]),
    ]);
    await expect(
      new AssemblyAiStt(net, 'fixture-key', { fallbackRegion: 'eu' }).start(input()),
    ).rejects.toMatchObject({ code: 1008, retryable: false });
    expect(net.log.filter((entry) => entry.kind === 'ws-open')).toHaveLength(1);
    net.assertComplete();
  });

  it('surfaces a mid-session close code on the next write', async () => {
    const net = createFixtureNet([
      socket('streaming.assemblyai.com', [
        { send: begin() },
        { expect: 'ws-send', match: 'binary' },
        { close: { code: 1011, reason: 'Internal error' } },
      ]),
    ]);
    const session = await new AssemblyAiStt(net, 'fixture-key').start(input());
    await session.write(new Uint8Array(400));
    await vi.waitFor(() => expect(net.log.some((entry) => entry.kind === 'ws-close')).toBe(true));
    // Regression: this used to be a generic "no longer writable" error with no code.
    await expect(session.write(new Uint8Array(160))).rejects.toMatchObject({
      name: 'AssemblyAiProviderError',
      code: 1011,
      retryable: true,
    });
    net.assertComplete();
  });
});

describe('AssemblyAI binding-aware languages', () => {
  it('accepts a Hinglish agent on the pro models and sends language_codes', async () => {
    const net = createFixtureNet([
      socket('streaming.assemblyai.com', [{ send: begin('universal-3-6-pro') }]),
    ]);
    const stt = new AssemblyAiStt(net, 'fixture-key', { model: 'universal-3-6-pro' });
    expect(stt.capabilities.languages).toContain('hi');
    expect(stt.capabilities.languages).toContain('ur');
    const session = await stt.start(input('hi-IN'));
    const url = new URL(net.log.find((entry) => entry.kind === 'ws-open')!.url!);
    expect(url.searchParams.get('speech_model')).toBe('universal-3-6-pro');
    expect(JSON.parse(url.searchParams.get('language_codes')!)).toEqual(['hi', 'en']);
    await session.cancel('done');
    net.assertComplete();
  });

  it('derives language_codes only for the code-switching pro models', () => {
    expect(assemblyAiLanguageCodes({ model: 'universal-3-5-pro' }, 'hi-IN')).toEqual(['hi', 'en']);
    expect(assemblyAiLanguageCodes({ model: 'universal-3-6-pro' }, 'en-IN')).toEqual(['en']);
    expect(assemblyAiLanguageCodes({ model: 'universal-3-6-pro' }, 'es-ES')).toEqual(['es']);
    expect(assemblyAiLanguageCodes({}, 'en-IN')).toBeUndefined();
    expect(new URL(assemblyAiUrl({}, MULAW_8K, 'en-IN')).searchParams.has('language_codes')).toBe(
      false,
    );
    expect(assemblyAiCapabilitiesFor({ model: 'universal-3-5-pro' }).languages).not.toContain('ur');
  });

  it('lists every model in the binding schema and the host compat language table', () => {
    const manifest = assemblyAiPlugin.manifest as unknown as {
      bindingSchema: { properties: { model: { enum: string[] }; region: { default: string } } };
      capabilities: { bindingLanguages: { by: Record<string, readonly string[]> } };
    };
    const schema = manifest.bindingSchema;
    expect(schema.properties.model.enum).toContain('universal-3-6-pro');
    expect(schema.properties.region.default).toBe('us');
    expect(Object.keys(manifest.capabilities.bindingLanguages.by)).toEqual(
      schema.properties.model.enum,
    );
  });
});
