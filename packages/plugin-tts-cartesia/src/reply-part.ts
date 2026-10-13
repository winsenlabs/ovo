import type { Clock, SynthesisInput } from '@winsendotai/ovo-contracts';
import { decimal } from '@winsendotai/ovo-plugin-kit';
import { AudioQueue } from './audio-queue.ts';
import type { CartesiaSocket, ContextSink } from './connection.ts';
import { CartesiaTtsError, type WholeSamples } from './errors.ts';

/**
 * A context is reused for the next segment only while it is surely alive: contexts "expire 1
 * second after the last audio output is streamed out", and sending on an expired one "is not
 * supported" (https://docs.cartesia.ai/use-the-api/tts-websocket/contexts.md, retrieved
 * 2026-10-13). After this much quiet the next segment opens a fresh context id instead.
 */
export const CONTEXT_QUIET_MS = 800;

export interface ReplyInit {
  contextId: string;
  requestId: string;
  input: Omit<SynthesisInput, 'text'>;
  fields: Record<string, unknown>;
  limit: number;
  clock: Pick<Clock, 'now' | 'setTimeout'>;
  /** The socket `openReply` connected; later contexts reconnect through `connect`. */
  socket: CartesiaSocket;
  connect(signal: AbortSignal): Promise<CartesiaSocket>;
  release(): void;
}

export interface Context {
  id: string;
  socket: CartesiaSocket;
  sink: ContextSink;
  samples: WholeSamples;
  flushes: number;
  heard: boolean;
  /** When the provider last sent anything for this context (or when it was opened). */
  quietSince: number;
}

export interface Part {
  index: number;
  /** Whole words and a trailing space: transcripts are concatenated verbatim [doc]. */
  text: string;
  chars: number;
  queue: AudioQueue;
  context?: Context;
  flushId: number;
  sent: boolean;
  everSent: boolean;
  heard: boolean;
  done: boolean;
  sentAt: number;
}

/** Letters, marks or digits: a segment of punctuation alone renders nothing and is not sent. */
export const speaks = (text: string) => /[\p{L}\p{M}\p{N}]/u.test(text);

/** A segment not yet sent: its words and a trailing space, its own audio queue. */
export function newPart(index: number, words: string, now: number): Part {
  return {
    index,
    text: `${words} `,
    chars: 0,
    queue: new AudioQueue(),
    flushId: 0,
    sent: false,
    everSent: false,
    heard: false,
    done: false,
    sentAt: now,
  };
}

/**
 * Ends `part` exactly once and meters it under `<requestId>/<n>` if it ever went out. As for a
 * single context, a segment the provider refused before any audio is not billed.
 */
export function finishPart(init: ReplyInit, part: Part, error?: Error): void {
  if (part.done) return;
  part.done = true;
  part.queue.end(error);
  if (!part.everSent) return;
  const refused = error instanceof CartesiaTtsError && !part.heard;
  init.input.onUsage({
    provider: 'cartesia',
    operation: 'tts',
    unit: 'characters',
    quantity: decimal(refused ? 0 : part.chars),
    state: 'estimated',
    requestId: `${init.requestId}/${part.index}`,
    elapsedMs: Math.max(0, init.clock.now() - part.sentAt),
  });
}
