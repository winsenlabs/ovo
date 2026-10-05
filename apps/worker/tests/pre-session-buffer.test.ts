import { EventEmitter } from 'node:events';
import { WebSocket } from '@winsendotai/ovo-plugin-media';
import { DEFAULT_KEEP_MS, DEFAULT_PRE_STT_BUFFER_MS } from '@winsendotai/ovo-plugin-voice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRE_SESSION_AUDIO_MS, PRE_SESSION_KEEP_MS } from '../src/pre-session-buffer.ts';
import { WorkerMediaLink } from '../src/worker-media-server.ts';
import { mediaRuntimeFixture, mediaSessionOpen } from './media-runtime-fixtures.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mu-law, as Twilio sends it.

/** A link whose voice session has not opened yet, fed caller audio as the gateway sends it. */
function link() {
  const gateway = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (_value: string, callback?: () => void) => callback?.(),
    close: vi.fn(),
  });
  const media = new WorkerMediaLink(
    mediaSessionOpen(mediaRuntimeFixture().route),
    gateway as unknown as WebSocket,
  );
  let sequence = 0;
  return {
    link: media,
    /** Caller audio from the gateway, 20 ms per frame. */
    speak(ms: number) {
      for (let at = 0; at < ms; at += 20)
        media.receive({
          type: 'media.audio',
          payload: Buffer.alloc(FRAME_BYTES, 0xff).toString('base64'),
          sequenceNumber: ++sequence,
          timestampMs: sequence * 20,
        });
    },
  };
}

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('worker media link pre-session replay', () => {
  it('buffers the same span the engine holds before STT connects', () => {
    expect(PRE_SESSION_AUDIO_MS).toBe(DEFAULT_PRE_STT_BUFFER_MS);
    expect(PRE_SESSION_KEEP_MS).toBe(DEFAULT_KEEP_MS);
  });

  it('drops the oldest audio instead of the call when the open outlasts the buffer', () => {
    const live = link();
    let bytes = 0;
    let first: number | undefined;
    live.link.onAudio((audio, at) => {
      bytes += audio.byteLength;
      first ??= at;
    });
    // Regression: past ten seconds the link ended the call as worker-input-buffer-overflow.
    live.speak(12_000);
    expect(live.link.isClosed).toBe(false);
    live.link.activate();
    // Frame 501 overflowed the 10 s span, which trimmed to the newest 3 s (frames 352-501); 99
    // more frames followed.
    expect(bytes).toBe(249 * FRAME_BYTES);
    expect(first).toBe(352 * 20);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\{"ts":"[^"]+","level":"warn","event":"pre_session_audio_dropped"/),
    );
  });

  it('replays buffered frames as ordered 200 ms chunks around other events', () => {
    const live = link();
    const seen: string[] = [];
    let bytes = 0;
    live.link.onAudio((audio, at) => {
      seen.push(`audio:${audio.byteLength}@${at}`);
      bytes += audio.byteLength;
    });
    live.link.onDtmf((digit) => seen.push(`dtmf:${digit}`));
    live.speak(300);
    live.link.receive({ type: 'media.dtmf', digit: '5' });
    live.speak(100);
    expect(seen).toEqual([]);
    live.link.activate();
    // 15 frames: one 200 ms chunk, the 100 ms remainder, the digit, then the later 100 ms.
    expect(seen).toEqual(['audio:1600@20', 'audio:800@220', 'dtmf:5', 'audio:800@320']);
    expect(bytes).toBe(400 * 8);
  });
});
