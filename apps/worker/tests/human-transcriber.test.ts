import { MULAW_8K, type SttEvent } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  HumanTranscriber,
  type Caption,
  type TranscriberInput,
  type TranscriptEvent,
} from '../src/human-transcriber.ts';
import { fakeStt } from './human-fixtures.ts';
import { flush } from './transfer-fixtures.ts';

const transcript = (text: string, final: boolean, segmentId = 'seg-1'): SttEvent => ({
  type: 'transcript',
  segment: { segmentId, revision: 1, text, stability: final ? 'final' : 'interim' },
});

function setup(over: Partial<TranscriberInput> = {}, sttOver: Parameters<typeof fakeStt>[0] = {}) {
  const stt = fakeStt(sttOver);
  const captions: Caption[] = [];
  const transcripts: TranscriptEvent[] = [];
  const failures: string[] = [];
  let at = 0;
  const input: TranscriberInput = {
    open: async () => stt.opened,
    usage: () => undefined,
    format: MULAW_8K,
    language: 'en-IN',
    sessionId: 'session-1',
    idPrefix: 's2:',
    operator: true,
    caption: (caption) => captions.push(caption),
    transcript: (event) => transcripts.push(event),
    now: () => (at += 10),
    failed: (reason) => failures.push(reason),
    ...over,
  };
  return { stt, input, captions, transcripts, failures };
}

describe('the silent transcriber (human queue design 7.5)', () => {
  it('listens to the caller and the operator on their own tracks', async () => {
    const t = setup();
    const transcriber = (await HumanTranscriber.open(t.input))!;
    await flush();
    expect(t.stt.sessions.map((s) => s.sessionId)).toEqual([
      'session-1:caller',
      'session-1:operator',
    ]);
    transcriber.callerAudio(new Uint8Array([1]));
    transcriber.operatorAudio(new Uint8Array([2]));
    await flush();
    expect(t.stt.sessions.map((s) => s.frames.map((f) => f[0]))).toEqual([[1], [2]]);
  });

  it('opens only the caller track when the operator is not transcribed', async () => {
    const t = setup({ operator: false });
    const transcriber = (await HumanTranscriber.open(t.input))!;
    await flush();
    transcriber.operatorAudio(new Uint8Array([2]));
    expect(t.stt.sessions).toHaveLength(1);
  });

  it('turns interims into captions only, and finals into captions and transcript events', async () => {
    const t = setup();
    await HumanTranscriber.open(t.input);
    await flush();
    const [caller, operator] = t.stt.sessions;
    caller!.emit(transcript('I need', false));
    caller!.emit(transcript('I need a refund', true));
    operator!.emit(transcript('Of course', true, 'seg-2'));
    expect(t.captions.map(({ role, text, final }) => [role, text, final])).toEqual([
      ['caller', 'I need', false],
      ['caller', 'I need a refund', true],
      ['operator', 'Of course', true],
    ]);
    expect(t.transcripts).toEqual([
      {
        type: 'user.transcript',
        turnId: 's2:hc1',
        segmentId: 's2:hc1',
        text: 'I need a refund',
        stability: 'final',
      },
      { type: 'agent.transcript', segmentId: 's2:ho1', text: 'Of course', state: 'played' },
    ]);
  });

  it('turns captions off, and nothing else, when the STT cannot open, start, write or report', async () => {
    const cannotOpen = setup({ open: async () => Promise.reject(new Error('no key')) });
    expect(await HumanTranscriber.open(cannotOpen.input)).toBeUndefined();
    expect(cannotOpen.failures).toEqual(['open_failed']);

    const none = setup({ open: async () => undefined });
    expect(await HumanTranscriber.open(none.input)).toBeUndefined();
    expect(none.failures).toEqual([]);

    const cannotStart = setup({}, { failStart: true });
    const started = (await HumanTranscriber.open(cannotStart.input))!;
    await flush();
    started.callerAudio(new Uint8Array([1]));
    expect(cannotStart.failures).toEqual(['start_failed']);

    const cannotWrite = setup({}, { failWrite: true });
    const written = (await HumanTranscriber.open(cannotWrite.input))!;
    await flush();
    written.callerAudio(new Uint8Array([1]));
    await flush();
    expect(cannotWrite.failures).toEqual(['write_failed']);
    // Off for good: no further audio reaches an STT.
    written.callerAudio(new Uint8Array([2]));
    expect(cannotWrite.stt.sessions[0]!.frames).toEqual([]);

    const throwing = setup({
      caption: () => {
        throw new Error('sink');
      },
    });
    await HumanTranscriber.open(throwing.input);
    await flush();
    throwing.stt.sessions[0]!.emit(transcript('hello', true));
    expect(throwing.failures).toEqual(['sink_failed']);
  });

  it('closes its sessions and the selection once', async () => {
    const t = setup();
    const transcriber = (await HumanTranscriber.open(t.input))!;
    await flush();
    await Promise.all([transcriber.close(), transcriber.close()]);
    expect(t.stt.sessions.every((s) => s.finished)).toBe(true);
    expect(t.stt.closes()).toBe(1);
    const late = vi.fn();
    t.input.caption = late;
    t.stt.sessions[0]!.emit(transcript('after close', true));
    expect(late).not.toHaveBeenCalled();
  });
});
