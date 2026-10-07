import { MULAW_8K, type NetFixtureScript } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { elevenLabsSttPlugin } from '../src/index.ts';
import { parseMessage } from '../src/protocol.ts';
import { ElevenLabsStt, scribeUrl } from '../src/provider.ts';
import { RETRIEVED, SOURCE, committed, sessionStarted } from '../src/testing.ts';

// Parameters from the reference's AsyncAPI query schema, and the event reference: "Committed
// transcript with word-level timestamps and the detected `language_code`. Sent after the committed
// transcript. Only received when `include_timestamps=true` or `include_language_detection=true`".
// https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime and
// https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference
// (both retrieved 2026-10-07).
const withLanguage = (language: string | null) =>
  JSON.stringify({
    message_type: 'committed_transcript_with_timestamps',
    text: 'haan main kar dunga',
    language_code: language,
    words: [],
  });

describe('Scribe language settings (N4/P9)', () => {
  it('sends nothing new by default: auto detection, as before', () => {
    const url = new URL(scribeUrl({}, MULAW_8K, 'en-IN'));
    for (const name of ['language_code', 'secondary_languages', 'include_language_detection'])
      expect(url.searchParams.has(name)).toBe(false);
  });

  it("pins the session language's base code in session mode", () => {
    const url = new URL(scribeUrl({ languageMode: 'session' }, MULAW_8K, 'en-IN'));
    expect(url.searchParams.get('language_code')).toBe('en');
  });

  it('pins the configured base language instead, such as hi for a Hinglish en-IN agent', () => {
    const url = new URL(
      scribeUrl({ languageMode: 'session', sessionLanguage: 'hi' }, MULAW_8K, 'en-IN'),
    );
    expect(url.searchParams.get('language_code')).toBe('hi');
    // Auto mode never pins, whatever the binding names.
    const auto = new URL(scribeUrl({ sessionLanguage: 'hi' }, MULAW_8K, 'en-IN'));
    expect(auto.searchParams.has('language_code')).toBe(false);
  });

  it('lists secondary languages and asks for language detection when bound', () => {
    const url = new URL(
      scribeUrl(
        {
          languageMode: 'session',
          secondaryLanguages: ['hi', 'ta'],
          languageDetection: true,
        },
        MULAW_8K,
        'en-IN',
      ),
    );
    expect(url.searchParams.getAll('secondary_languages')).toEqual(['hi', 'ta']);
    expect(url.searchParams.get('include_language_detection')).toBe('true');
  });

  it('validates the new binding fields against the Scribe languages', () => {
    const manifest = elevenLabsSttPlugin.manifest as { bindingSchema?: unknown };
    const schema = manifest.bindingSchema as {
      properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
    };
    expect(schema.properties.sessionLanguage?.enum).toContain('hi');
    expect(schema.properties.sessionLanguage?.enum).not.toContain('en-IN');
    expect(schema.properties.secondaryLanguages?.items?.enum).toContain('ta');
  });

  it('reads the detected language and ignores the message without one', () => {
    expect(parseMessage(withLanguage('hi'))).toEqual({ kind: 'language', language: 'hi' });
    expect(parseMessage(withLanguage(null))).toEqual({ kind: 'ignored' });
  });
});

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('Scribe detected language', () => {
  it('logs the language of each commit after the final, never delaying it', async () => {
    const lines: string[] = [];
    const info = vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
    const clock = new FakeClock();
    const script: NetFixtureScript[] = [
      {
        host: 'api.elevenlabs.io',
        source: SOURCE,
        retrieved: RETRIEVED,
        steps: [
          { expect: 'ws-open', url: /include_language_detection=true/ },
          { send: sessionStarted() },
          {
            expect: 'ws-send',
            match: 'json',
            where: { message_type: 'input_audio_chunk', commit: false },
            repeat: 'until-next',
          },
          { send: committed('haan main kar dunga') },
          { send: withLanguage('hi') },
        ],
      },
    ];
    const events: string[] = [];
    const session = await new ElevenLabsStt(
      createFixtureNet(script, { clock }),
      'fixture-key',
      { languageDetection: true },
      clock,
    ).start({
      sessionId: 'scribe-language',
      format: MULAW_8K,
      language: 'en-IN',
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.type),
      onUsage: () => undefined,
    });
    await session.write(new Uint8Array(400).fill(1));
    await session.cancel('done');
    expect(events).toEqual(['transcript', 'end-of-turn']);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged.find((entry) => entry.event === 'stt_language_detected')).toMatchObject({
      sessionId: 'scribe-language',
      language: 'hi',
      expected: 'en-IN',
    });
    info.mockRestore();
  });
});
