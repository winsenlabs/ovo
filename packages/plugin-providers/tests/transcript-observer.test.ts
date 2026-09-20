import { describe, expect, it } from 'vitest';
import type { StreamingStt, TranscriptRevision } from '@winsendotai/ovo-plugin-voice';
import { observeStreamingTranscripts } from '../src/index.ts';

describe('Deepgram transcript observation', () => {
  it('observes an immutable copy before forwarding every revision', async () => {
    let providerCallback!: (revision: TranscriptRevision) => void;
    const streaming: StreamingStt = {
      async start(input) {
        providerCallback = input.onTranscript;
        return {
          async write() {},
          async finish() {},
          async close() {},
        };
      },
    };
    const order: string[] = [];
    let observed: Readonly<TranscriptRevision> | undefined;
    const wrapped = observeStreamingTranscripts(streaming, (revision) => {
      order.push('observe');
      observed = revision;
      expect(Object.isFrozen(revision)).toBe(true);
    });
    await wrapped.start({
      sessionId: 'session',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      language: 'en',
      signal: new AbortController().signal,
      onTranscript(revision) {
        order.push('engine');
        revision.text = 'engine mutation';
      },
    });
    providerCallback({ revision: 1, text: 'customer words', isFinal: true, speechFinal: true });
    expect(order).toEqual(['observe', 'engine']);
    expect(observed?.text).toBe('customer words');
  });

  it('isolates observer failures from the engine callback', async () => {
    let providerCallback!: (revision: TranscriptRevision) => void;
    let forwarded = false;
    const wrapped = observeStreamingTranscripts(
      {
        async start(input) {
          providerCallback = input.onTranscript;
          return { async write() {}, async finish() {}, async close() {} };
        },
      },
      () => {
        throw new Error('audit unavailable');
      },
    );
    await wrapped.start({
      sessionId: 'session',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      language: 'en',
      signal: new AbortController().signal,
      onTranscript() {
        forwarded = true;
      },
    });
    providerCallback({ revision: 1, text: 'hello', isFinal: false, speechFinal: false });
    expect(forwarded).toBe(true);
  });

  it('isolates asynchronous observer failures from the engine callback', async () => {
    let providerCallback!: (revision: TranscriptRevision) => void;
    let forwarded = false;
    const wrapped = observeStreamingTranscripts(
      {
        async start(input) {
          providerCallback = input.onTranscript;
          return { async write() {}, async finish() {}, async close() {} };
        },
      },
      async () => {
        throw new Error('async audit unavailable');
      },
    );
    await wrapped.start({
      sessionId: 'session',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      language: 'en',
      signal: new AbortController().signal,
      onTranscript() {
        forwarded = true;
      },
    });
    providerCallback({ revision: 1, text: 'hello', isFinal: true, speechFinal: true });
    await Promise.resolve();
    expect(forwarded).toBe(true);
  });
});
