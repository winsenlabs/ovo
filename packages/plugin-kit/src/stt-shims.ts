import {
  MULAW_8K,
  sameFormat,
  type AudioFormat,
  type SpeechCapabilities,
  type SpeechToText,
  type StreamingStt,
  type StreamingSttSession,
  type SttEvent,
  type SttSession,
  type TranscriptRevision,
  type UsageSink,
} from '@winsendotai/ovo-contracts';

const LEGACY_STT_CAPABILITIES: SpeechCapabilities = Object.freeze({
  inputFormats: Object.freeze([MULAW_8K]),
  languages: Object.freeze(['*']),
  interim: true,
  wordTimestamps: false,
  turnSignals: Object.freeze(['speech-start', 'end-of-turn'] as const),
  forceEndpoint: false,
});

/**
 * v1 → v2 STT (§2.11). `isFinal` locks the segment and the next revision starts a new segmentId;
 * `speechFinal` becomes `end-of-turn`; `speechStarted` becomes `speech-start`. Revisions are
 * renumbered so they are strictly monotonic per session.
 */
export function legacyAsStt(
  v1: StreamingStt,
  options: { capabilities?: Partial<SpeechCapabilities> } = {},
): SpeechToText {
  const capabilities = Object.freeze({ ...LEGACY_STT_CAPABILITIES, ...options.capabilities });
  return {
    capabilities,
    async start(input) {
      if (!sameFormat(input.format, MULAW_8K))
        throw new TypeError('A v1 STT accepts only MULAW_8K; the host adapter transcodes');
      let segment = 0;
      let revision = 0;
      let interimOpen = false;
      let speaking = false;
      const emit = (event: SttEvent) => input.onEvent(event);
      const onTranscript = (rev: TranscriptRevision) => {
        if (rev.speechStarted && !speaking) {
          speaking = true;
          emit({
            type: 'speech-start',
            ...(rev.startMs === undefined ? {} : { atMs: rev.startMs }),
          });
        }
        const text = rev.text.trim();
        if (text || (rev.isFinal && interimOpen)) {
          const endMs =
            rev.startMs !== undefined && rev.durationMs !== undefined
              ? rev.startMs + rev.durationMs
              : undefined;
          emit({
            type: 'transcript',
            segment: {
              segmentId: `${input.sessionId}:${segment}`,
              revision: ++revision,
              text,
              stability: rev.isFinal ? 'final' : 'interim',
              ...(rev.confidence === undefined ? {} : { confidence: rev.confidence }),
              ...(rev.startMs === undefined ? {} : { startMs: rev.startMs }),
              ...(endMs === undefined ? {} : { endMs }),
            },
          });
          interimOpen = !rev.isFinal;
          if (rev.isFinal) segment += 1;
        }
        if (rev.speechFinal) {
          speaking = false;
          emit({ type: 'end-of-turn' });
        }
      };
      const session = await v1.start({
        sessionId: input.sessionId,
        codec: 'audio/x-mulaw',
        sampleRate: 8000,
        language: input.language,
        signal: input.signal,
        onTranscript,
      });
      return legacySession(session);
    },
  };
}

function legacySession(session: StreamingSttSession): SttSession {
  let closed = false;
  return {
    write: (frame, signal) =>
      closed ? Promise.reject(new Error('STT session is closed')) : session.write(frame, signal),
    async finish(signal) {
      if (closed) return;
      closed = true;
      await session.finish(signal);
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      await session.close(reason);
    },
  };
}

/**
 * v2 → v1 STT (§2.11). Finals of the current turn accumulate; `end-of-turn` (or `utterance-end`)
 * emits one `isFinal + speechFinal` revision carrying the whole turn's text.
 */
export function sttAsLegacy(
  v2: SpeechToText,
  format: AudioFormat = MULAW_8K,
  options: { onUsage?: UsageSink } = {},
): StreamingStt {
  return {
    async start(input) {
      let revision = 0;
      const finals = new Map<string, string>();
      const turnText = () => [...finals.values()].filter(Boolean).join(' ');
      const push = (rev: Omit<TranscriptRevision, 'revision'>) =>
        input.onTranscript({ ...rev, revision: ++revision });
      const endTurn = () => {
        const text = turnText();
        finals.clear();
        if (text) push({ text, isFinal: true, speechFinal: true, speechStarted: true });
      };
      const session = await v2.start({
        sessionId: input.sessionId,
        format,
        language: input.language,
        signal: input.signal,
        onUsage: options.onUsage ?? (() => undefined),
        onEvent(event) {
          if (event.type === 'transcript') {
            const { segment } = event;
            if (segment.stability === 'final') finals.set(segment.segmentId, segment.text);
            push({
              text: segment.text,
              isFinal: segment.stability === 'final',
              speechFinal: false,
              speechStarted: Boolean(segment.text.trim()),
              ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
              ...(segment.startMs === undefined ? {} : { startMs: segment.startMs }),
              ...(segment.startMs !== undefined && segment.endMs !== undefined
                ? { durationMs: segment.endMs - segment.startMs }
                : {}),
            });
          } else if (event.type === 'end-of-turn' && !event.eager) endTurn();
          else if (event.type === 'utterance-end') endTurn();
        },
      });
      return {
        write: (audio, signal) => session.write(audio, signal),
        finish: (signal) => session.finish(signal),
        close: (reason) => session.cancel(reason),
      };
    },
  };
}
