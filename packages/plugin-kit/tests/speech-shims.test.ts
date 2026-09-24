import { describe, expect, it } from 'vitest';
import {
  MULAW_8K,
  PCM16_16K,
  type StreamingStt,
  type StreamingTts,
  type SttEvent,
  type TranscriptRevision,
  type VoiceMediaTransport,
} from '@winsendotai/ovo-contracts';
import {
  asEndReason,
  duplexFromLegacy,
  legacyAsStt,
  legacyAsTts,
  legacyFromDuplex,
  sttAsLegacy,
  ttsAsLegacy,
} from '../src/index.ts';

function legacyStt(
  revisions: Omit<TranscriptRevision, 'revision'>[],
): StreamingStt & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    async start(input) {
      revisions.forEach((rev, i) => input.onTranscript({ ...rev, revision: 100 - i }));
      return {
        write: async () => undefined,
        finish: async () => undefined,
        close: async (reason) => void closed.push(reason),
      };
    },
  };
}

const start = {
  sessionId: 's1',
  format: MULAW_8K,
  language: 'en',
  signal: new AbortController().signal,
  onUsage: () => undefined,
};

describe('legacyAsStt (§2.11)', () => {
  it('maps isFinal to a locked segment, speechFinal to end-of-turn and speechStarted to speech-start', async () => {
    const events: SttEvent[] = [];
    const v1 = legacyStt([
      { text: 'hel', isFinal: false, speechFinal: false, speechStarted: true },
      { text: 'hello', isFinal: true, speechFinal: false },
      { text: 'there', isFinal: true, speechFinal: true, startMs: 100, durationMs: 50 },
      { text: 'again', isFinal: false, speechFinal: false, speechStarted: true },
    ]);
    const session = await legacyAsStt(v1).start({ ...start, onEvent: (e) => events.push(e) });
    expect(
      events.map((e) =>
        e.type === 'transcript'
          ? `${e.segment.segmentId}:${e.segment.stability}:${e.segment.text}`
          : e.type,
      ),
    ).toEqual([
      'speech-start',
      's1:0:interim:hel',
      's1:0:final:hello',
      's1:1:final:there',
      'end-of-turn',
      'speech-start',
      's1:2:interim:again',
    ]);
    const revisions = events.flatMap((e) => (e.type === 'transcript' ? [e.segment.revision] : []));
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(events.find((e) => e.type === 'transcript' && e.segment.text === 'there')).toMatchObject(
      { segment: { startMs: 100, endMs: 150 } },
    );
    await session.cancel('bye');
    await expect(session.write(new Uint8Array(1))).rejects.toThrow(/closed/);
    expect(v1.closed).toEqual(['bye']);
  });

  it('refuses non-native formats', async () => {
    await expect(
      legacyAsStt(legacyStt([])).start({ ...start, format: PCM16_16K, onEvent: () => undefined }),
    ).rejects.toThrow(/MULAW_8K/);
  });
});

describe('sttAsLegacy (§2.11)', () => {
  it('releases the turn text on end-of-turn as one isFinal+speechFinal revision', async () => {
    const revisions: TranscriptRevision[] = [];
    let emit!: (event: SttEvent) => void;
    const v2 = legacyAsStt(legacyStt([]));
    const wrapped = sttAsLegacy({
      capabilities: v2.capabilities,
      async start(input) {
        emit = input.onEvent;
        return {
          write: async () => undefined,
          finish: async () => undefined,
          cancel: async () => undefined,
        };
      },
    });
    await wrapped.start({
      sessionId: 's',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      language: 'en',
      signal: new AbortController().signal,
      onTranscript: (r) => revisions.push(r),
    });
    emit({
      type: 'transcript',
      segment: { segmentId: 'a', revision: 1, text: 'book a', stability: 'interim' },
    });
    emit({
      type: 'transcript',
      segment: { segmentId: 'a', revision: 2, text: 'book a table', stability: 'final' },
    });
    emit({
      type: 'transcript',
      segment: { segmentId: 'b', revision: 3, text: 'for two', stability: 'final' },
    });
    emit({ type: 'end-of-turn' });
    expect(revisions.at(-1)).toMatchObject({
      text: 'book a table for two',
      isFinal: true,
      speechFinal: true,
    });
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
  });
});

describe('TTS shims', () => {
  it('bridges v1 μ-law TTS to v2 and back', async () => {
    const v1: StreamingTts = {
      async *synthesize(input) {
        yield new TextEncoder().encode(`${input.text}:${input.voice ?? '-'}`);
      },
    };
    const v2 = legacyAsTts(v1, {
      provider: 'openai',
      model: 'tts-1',
      voice: 'alloy',
      revision: 'openai-tts-mulaw-8000-v1',
    });
    expect(v2.cacheIdentity(MULAW_8K)).toEqual({
      provider: 'openai',
      model: 'tts-1',
      voice: 'alloy',
      revision: 'openai-tts-mulaw-8000-v1',
    });
    expect(() => v2.synthesize({ ...start, text: 'x', format: PCM16_16K })).toThrow(/MULAW_8K/);
    const back = ttsAsLegacy(v2);
    const chunks: Uint8Array[] = [];
    for await (const chunk of back.synthesize({
      sessionId: 's',
      text: 'hi',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      voice: 'v',
      signal: new AbortController().signal,
    }))
      chunks.push(chunk);
    expect(new TextDecoder().decode(chunks[0])).toBe('hi:v');
  });
});

describe('duplex shims', () => {
  it('adapts a v1 transport to MediaDuplex and back, synthesizing cleared', async () => {
    const calls: string[] = [];
    const listeners: Record<string, (value: string) => void> = {};
    const transport: VoiceMediaTransport = {
      sessionId: 's1',
      bufferedBytes: 3,
      sendAudio: async () => void calls.push('audio'),
      sendMark: async (name) => void calls.push(`mark:${name}`),
      clear: async () => void calls.push('clear'),
      onAudio: () => () => undefined,
      onMark: (fn) => ((listeners.mark = fn), () => undefined),
      onDtmf: () => () => undefined,
      onClose: (fn) => ((listeners.close = fn), () => undefined),
      close: async (reason) => void calls.push(`close:${reason}`),
    };
    const duplex = duplexFromLegacy(transport, MULAW_8K, 'carrier-played', {
      carrierId: 'twilio',
      clearFlushesMarkers: true,
    });
    const seen: string[] = [];
    duplex.onPlayed((name) => seen.push(`played:${name}`));
    duplex.onCleared(() => seen.push('cleared'));
    duplex.onClose((reason) => seen.push(`closed:${reason}`));
    await duplex.mark('m1');
    listeners.mark!('m1');
    await duplex.clear();
    listeners.close!('stop');
    expect(seen).toEqual(['played:m1', 'cleared', 'closed:caller_hangup']);
    expect(duplex.bufferedBytes).toBe(3);
    const legacy = legacyFromDuplex(duplex);
    await legacy.close('drain');
    await legacy.sendMark('m2');
    expect(calls).toEqual(['mark:m1', 'clear', 'close:drain', 'mark:m2']);
    expect(asEndReason('something odd')).toBe('error:something odd');
    expect(asEndReason('ownership_lost')).toBe('ownership_lost');
    expect(asEndReason('worker-shutdown')).toBe('drain');
    expect(asEndReason('job-lease-lost')).toBe('ownership_lost');
    expect(asEndReason('task-protection-renewal-failed')).toBe('ownership_lost');
    expect(asEndReason('media-gateway-disconnected')).toBe('ownership_lost');
    expect(asEndReason('gateway disconnected')).toBe('ownership_lost');
    expect(asEndReason('carrier terminal: completed')).toBe('error:carrier-terminal:completed');
    expect(asEndReason('cost-spend-threshold')).toBe('error:cost-spend-threshold');
    expect(asEndReason('cost-meter-unconfigured:openai.inference.input_tokens')).toBe(
      'error:cost-meter-unconfigured',
    );
    expect(asEndReason('carrier termination')).toBe('error:carrier termination');
  });
});
