import {
  MULAW_8K,
  bytesPerSecond,
  type AudioFormat,
  type CarrierMediaEvent,
  type Clock,
  type EndReason,
  type MediaCodecSession,
  type MediaDuplex,
  type PlaybackEvidence,
} from '@winsendotai/ovo-contracts';
import { realClock } from './fake-clock.ts';

export type FakeCarrierLogEntry =
  | { type: 'audio'; bytes: number; atMs: number }
  | { type: 'mark'; name: string; atMs: number }
  | { type: 'mark-aborted'; name: string; atMs: number }
  | { type: 'clear'; atMs: number }
  | { type: 'played'; name: string; flushed: boolean; atMs: number }
  | { type: 'cleared'; atMs: number }
  | { type: 'close'; reason: EndReason; by: 'host' | 'caller'; atMs: number };

export interface FakeCarrierOptions {
  format?: AudioFormat;
  carrierId?: string;
  sessionId?: string;
  playbackEvidence?: PlaybackEvidence;
  /** Twilio echoes pending marks on clear (true); 'unknown' is treated as echoing. */
  clearFlushesMarkers?: boolean | 'unknown';
  clock?: Clock;
  /** 'realtime' drains queued audio at bytesPerSecond; 'manual' waits for `drain()`. */
  playback?: 'realtime' | 'manual';
  /** A carrier's real codec session: host commands are encoded through it (frames in `wire`). */
  codec?: MediaCodecSession;
  /** Builds the carrier's inbound wire frame for an event, which `codec.decode` must parse back. */
  inbound?: (event: CarrierMediaEvent) => string;
}

type Queued = { kind: 'audio'; bytes: number } | { kind: 'mark'; name: string };

export interface FakeCarrier {
  readonly duplex: MediaDuplex;
  readonly log: readonly FakeCarrierLogEntry[];
  /** Encoded host → carrier frames, when a codec is attached. */
  readonly wire: readonly string[];
  readonly caller: {
    audio(bytes: Uint8Array): void;
    dtmf(digit: string): void;
    answeredBy(value: 'human' | 'machine' | 'unknown'): void;
    hangup(reason?: EndReason): void;
  };
  /** Manual playback: plays everything queued now (marks echo per the evidence setting). */
  drain(): void;
  readonly closed: boolean;
}

export function createFakeCarrier(options: FakeCarrierOptions = {}): FakeCarrier {
  const format = options.format ?? MULAW_8K;
  const evidence = options.playbackEvidence ?? 'carrier-played';
  const flushes = options.clearFlushesMarkers ?? true;
  const clock = options.clock ?? realClock;
  const realtime = (options.playback ?? 'realtime') === 'realtime';
  const rate = bytesPerSecond(format);
  const log: FakeCarrierLogEntry[] = [];
  const wire: string[] = [];
  const queue: Queued[] = [];
  const listeners = {
    audio: new Set<(bytes: Uint8Array, ts: number) => void>(),
    played: new Set<(name: string) => void>(),
    cleared: new Set<() => void>(),
    dtmf: new Set<(digit: string) => void>(),
    answeredBy: new Set<(value: 'human' | 'machine' | 'unknown') => void>(),
    close: new Set<(reason: EndReason) => void>(),
  };
  let buffered = 0;
  let cancelDrain: (() => void) | undefined;
  let closed = false;
  let seq = 0;
  const at = () => clock.now();
  const subscribe = <T>(set: Set<T>, fn: T) => {
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  };
  const encode = (command: Parameters<MediaCodecSession['encode']>[0]) => {
    if (!options.codec) return;
    if (command.type === 'mark') wire.push(...options.codec.flush());
    wire.push(...options.codec.encode(command));
  };
  /** Inbound events go through the carrier's own frames when a builder is attached. */
  const deliver = (event: CarrierMediaEvent) => {
    const events =
      options.inbound && options.codec ? options.codec.decode(options.inbound(event)) : [event];
    for (const e of events) {
      if (e.type === 'audio') for (const fn of [...listeners.audio]) fn(e.payload, e.timestampMs);
      else if (e.type === 'played') for (const fn of [...listeners.played]) fn(e.name);
      else if (e.type === 'cleared') for (const fn of [...listeners.cleared]) fn();
      else if (e.type === 'dtmf') for (const fn of [...listeners.dtmf]) fn(e.digit);
    }
  };
  const played = (name: string, flushed: boolean) => {
    log.push({ type: 'played', name, flushed, atMs: at() });
    if (evidence !== 'none') deliver({ type: 'played', name });
  };
  const pump = () => {
    cancelDrain = undefined;
    while (queue.length && !closed) {
      const head = queue[0]!;
      if (head.kind === 'mark') {
        queue.shift();
        played(head.name, false);
        continue;
      }
      if (!realtime) return;
      cancelDrain = clock.setTimeout(
        () => {
          queue.shift();
          buffered -= head.bytes;
          pump();
        },
        (head.bytes / rate) * 1000,
      );
      return;
    }
  };
  const kick = () => {
    if (!cancelDrain) pump();
  };
  const close = (reason: EndReason, by: 'host' | 'caller') => {
    if (closed) return;
    closed = true;
    cancelDrain?.();
    queue.length = 0;
    buffered = 0;
    log.push({ type: 'close', reason, by, atMs: at() });
    for (const fn of [...listeners.close]) fn(reason);
  };

  const duplex: MediaDuplex = {
    sessionId: options.sessionId ?? 'fake-session',
    carrierId: options.carrierId ?? 'fake',
    format,
    playbackEvidence: evidence,
    clearFlushesMarkers: flushes,
    get bufferedBytes() {
      return buffered;
    },
    async sendAudio(bytes) {
      if (closed) throw new Error('media is closed');
      encode({ type: 'audio', payload: bytes });
      log.push({ type: 'audio', bytes: bytes.byteLength, atMs: at() });
      if (bytes.byteLength === 0) return;
      queue.push({ kind: 'audio', bytes: bytes.byteLength });
      buffered += bytes.byteLength;
      kick();
    },
    async mark(name, signal) {
      if (closed) throw new Error('media is closed');
      encode({ type: 'mark', name });
      log.push({ type: 'mark', name, atMs: at() });
      if (signal) {
        const aborted = () => log.push({ type: 'mark-aborted', name, atMs: at() });
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
      }
      queue.push({ kind: 'mark', name });
      kick();
    },
    async clear() {
      if (closed) return;
      encode({ type: 'clear' });
      log.push({ type: 'clear', atMs: at() });
      cancelDrain?.();
      cancelDrain = undefined;
      const pending = queue.splice(0).filter((item) => item.kind === 'mark');
      buffered = 0;
      if (flushes !== false) for (const item of pending) played(item.name, true);
      queueMicrotask(() => {
        if (closed) return;
        log.push({ type: 'cleared', atMs: at() });
        deliver({ type: 'cleared' });
      });
    },
    onAudio: (fn) => subscribe(listeners.audio, fn),
    onPlayed: (fn) => subscribe(listeners.played, fn),
    onCleared: (fn) => subscribe(listeners.cleared, fn),
    onDtmf: (fn) => subscribe(listeners.dtmf, fn),
    onAnsweredBy: (fn) => subscribe(listeners.answeredBy, fn),
    onClose: (fn) => subscribe(listeners.close, fn),
    async close(reason) {
      options.codec?.terminate?.().forEach((frame) => wire.push(frame));
      close(reason, 'host');
    },
  };

  return {
    duplex,
    log,
    wire,
    get closed() {
      return closed;
    },
    caller: {
      audio(bytes) {
        if (!closed) deliver({ type: 'audio', seq: ++seq, timestampMs: at(), payload: bytes });
      },
      dtmf(digit) {
        if (!closed) deliver({ type: 'dtmf', digit });
      },
      answeredBy(value) {
        for (const fn of [...listeners.answeredBy]) fn(value);
      },
      hangup(reason = 'caller_hangup') {
        close(reason, 'caller');
      },
    },
    drain() {
      while (queue.length) {
        const head = queue.shift()!;
        if (head.kind === 'mark') played(head.name, false);
        else buffered -= head.bytes;
      }
    },
  };
}

/** A manual MediaDuplex fake: nothing plays until `drain()`. */
export function createFakeDuplex(options: Omit<FakeCarrierOptions, 'playback'> = {}): FakeCarrier {
  return createFakeCarrier({ ...options, playback: 'manual' });
}
