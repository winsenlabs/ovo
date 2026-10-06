// Wire details of the Scribe v2 realtime WebSocket. Message and parameter names come from
// https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime and
// https://elevenlabs.io/docs/developers/guides/cookbooks/speech-to-text/realtime/transcripts-and-commit-strategies
// (both retrieved 2026-10-06).

export class ElevenLabsSttError extends Error {
  constructor(
    message: string,
    /** A WebSocket close code, the provider's error `message_type`, or a local failure. */
    readonly code: number | string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ElevenLabsSttError';
  }
}

/** Error message types the reference lists; every one carries an `error` string. */
const FATAL_ERRORS = new Set([
  'error',
  'auth_error',
  'quota_exceeded',
  'unaccepted_terms',
  'rate_limited',
  'queue_overflow',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'input_error',
  'invalid_request',
  'chunk_size_exceeded',
  'transcriber_error',
]);

/**
 * A reconnect can help: the provider is busy or failed internally, or this session ran out of
 * time. Credentials, quota, terms and malformed requests fail the same way again.
 */
const RETRYABLE_ERRORS = new Set([
  'rate_limited',
  'queue_overflow',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'transcriber_error',
]);

/**
 * Reported without ending the session; the session finalises a throttled commit's partial itself.
 * [unconfirmed: the reference lists these types but not whether the server closes the socket
 * after them.]
 */
const NOTICES = new Set(['warning', 'commit_throttled', 'insufficient_audio_activity']);

export type ScribeMessage =
  | { kind: 'started'; sessionId: string }
  | { kind: 'partial'; text: string }
  | { kind: 'committed'; text: string }
  | { kind: 'notice'; type: string; detail: string }
  | { kind: 'failure'; error: ElevenLabsSttError }
  | { kind: 'ignored' };

/** Parses one server frame; a malformed or unknown-shaped frame is a protocol failure. */
export function parseMessage(raw: string): ScribeMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // swallow-ok: a frame that is not JSON becomes the session's typed protocol failure.
    return protocol('malformed response');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return protocol('not an object');
  const message = value as Record<string, unknown>;
  const type = message.message_type;
  if (typeof type !== 'string') return protocol('message has no message_type');
  if (type === 'session_started')
    return typeof message.session_id === 'string' && message.session_id
      ? { kind: 'started', sessionId: message.session_id }
      : protocol('session_started has no session_id');
  if (type === 'partial_transcript' || type === 'committed_transcript') {
    if (typeof message.text !== 'string') return protocol(`${type} has no text`);
    return { kind: type === 'partial_transcript' ? 'partial' : 'committed', text: message.text };
  }
  const detail = typeof message.error === 'string' ? message.error : type;
  if (NOTICES.has(type)) return { kind: 'notice', type, detail };
  if (FATAL_ERRORS.has(type))
    return {
      kind: 'failure',
      error: new ElevenLabsSttError(
        `ElevenLabs STT ${type}: ${detail}`,
        type,
        RETRYABLE_ERRORS.has(type),
      ),
    };
  // committed_transcript_with_timestamps, entities and edits follow only opt-in parameters this
  // plugin never sends; the plain committed transcript already carries the final text.
  return { kind: 'ignored' };
}

function protocol(detail: string): ScribeMessage {
  return {
    kind: 'failure',
    error: new ElevenLabsSttError(`ElevenLabs STT ${detail}`, 'protocol', false),
  };
}

/**
 * Closes that a new session may recover from: an abnormal drop, a server going away or
 * restarting, an internal error, or "try again later".
 */
export function retryableClose(code: number): boolean {
  return code === 1001 || code === 1006 || code === 1011 || code === 1012 || code === 1013;
}

/** The documented client frame. `commit` and `sample_rate` are required on every chunk. */
export function audioChunk(audio: Uint8Array, sampleRate: number, commit: boolean): string {
  let binary = '';
  for (let offset = 0; offset < audio.byteLength; offset += 0x8000)
    binary += String.fromCharCode(...audio.subarray(offset, offset + 0x8000));
  return JSON.stringify({
    message_type: 'input_audio_chunk',
    audio_base_64: btoa(binary),
    commit,
    sample_rate: sampleRate,
  });
}
