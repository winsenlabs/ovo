// Wire details of an OpenAI Realtime transcription session over WebSocket (STT-12). Event names
// and fields come from
// https://developers.openai.com/api/docs/guides/realtime-transcription,
// https://developers.openai.com/api/reference/resources/realtime/client-events and
// https://developers.openai.com/api/reference/resources/realtime/server-events
// (all retrieved 2026-10-06).

export class OpenAiRealtimeSttError extends Error {
  constructor(
    message: string,
    /** A WebSocket close code, the provider's error `code`/`type`, or a local failure. */
    readonly code: number | string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OpenAiRealtimeSttError';
  }
}

export type RealtimeMessage =
  | { kind: 'created'; sessionId: string }
  | { kind: 'updated' }
  | { kind: 'committed'; itemId: string }
  | { kind: 'speech'; phase: 'started' | 'stopped' }
  | { kind: 'delta'; itemId: string; delta: string }
  | { kind: 'completed'; itemId: string; transcript: string }
  | { kind: 'item-failed'; itemId: string; detail: string }
  | { kind: 'error'; detail: string; code: string; eventId?: string }
  | { kind: 'failure'; error: OpenAiRealtimeSttError }
  | { kind: 'ignored' };

const text = (value: unknown): value is string => typeof value === 'string';

/** Parses one server event; a malformed frame or a known event missing its fields is a failure. */
export function parseMessage(raw: string): RealtimeMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // swallow-ok: a frame that is not JSON becomes the session's typed protocol failure.
    return protocol('malformed event');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return protocol('not an object');
  const event = value as Record<string, unknown>;
  const type = event.type;
  if (!text(type)) return protocol('event has no type');
  switch (type) {
    case 'session.created': {
      const session = event.session as Record<string, unknown> | undefined;
      return text(session?.id) && session.id
        ? { kind: 'created', sessionId: session.id }
        : protocol('session.created has no session id');
    }
    case 'session.updated':
      return { kind: 'updated' };
    case 'input_audio_buffer.committed':
      return text(event.item_id)
        ? { kind: 'committed', itemId: event.item_id }
        : protocol(`${type} has no item_id`);
    case 'input_audio_buffer.speech_started':
    case 'input_audio_buffer.speech_stopped':
      return { kind: 'speech', phase: type.endsWith('started') ? 'started' : 'stopped' };
    case 'conversation.item.input_audio_transcription.delta':
      return text(event.item_id) && text(event.delta)
        ? { kind: 'delta', itemId: event.item_id, delta: event.delta }
        : protocol(`${type} has no item_id or delta`);
    case 'conversation.item.input_audio_transcription.completed':
      return text(event.item_id) && text(event.transcript)
        ? { kind: 'completed', itemId: event.item_id, transcript: event.transcript }
        : protocol(`${type} has no item_id or transcript`);
    case 'conversation.item.input_audio_transcription.failed': {
      const error = event.error as Record<string, unknown> | undefined;
      return text(event.item_id)
        ? {
            kind: 'item-failed',
            itemId: event.item_id,
            detail: text(error?.message) ? error.message : 'transcription failed',
          }
        : protocol(`${type} has no item_id`);
    }
    case 'error': {
      const error = (event.error ?? {}) as Record<string, unknown>;
      return {
        kind: 'error',
        detail: text(error.message) ? error.message : 'provider error',
        code: text(error.code) ? error.code : text(error.type) ? error.type : 'error',
        ...(text(error.event_id) ? { eventId: error.event_id } : {}),
      };
    }
    default:
      // conversation.item.added/done, input_audio_buffer.cleared, transcription segments and rate
      // limits carry nothing a transcript needs.
      return { kind: 'ignored' };
  }
}

function protocol(detail: string): RealtimeMessage {
  return {
    kind: 'failure',
    error: new OpenAiRealtimeSttError(`OpenAI realtime STT ${detail}`, 'protocol', false),
  };
}

/** Closes a new session may recover from: a drop, a restart, an internal error, try again later. */
export function retryableClose(code: number): boolean {
  return code === 1001 || code === 1006 || code === 1011 || code === 1012 || code === 1013;
}

export function appendEvent(audio: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < audio.byteLength; offset += 0x8000)
    binary += String.fromCharCode(...audio.subarray(offset, offset + 0x8000));
  return JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(binary) });
}

/** A commit carries its own event id, so an error about it can be told apart from others. */
export function commitEvent(eventId: string): string {
  return JSON.stringify({ type: 'input_audio_buffer.commit', event_id: eventId });
}
