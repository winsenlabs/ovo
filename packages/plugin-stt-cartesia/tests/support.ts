import {
  MULAW_8K,
  type NetPort,
  type SttEvent,
  type UsageMeter,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import type { Start } from '../src/session.ts';

type Listener = (...args: never[]) => void;

/**
 * A provider socket the test drives by hand: it records every frame the plugin sends, and the
 * test plays the server (`open`, `reply`, `drop`). Bare text frames such as `finalize` are plain
 * strings here, so exact-text expectations need no fixture matcher.
 */
export class FakeSocket implements WebSocketLike {
  readyState: 0 | 1 | 2 | 3 = 0;
  readonly sent: (string | Uint8Array)[] = [];
  closedWith?: number;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  on(event: string, fn: Listener): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(event, set);
    return () => set.delete(fn);
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.readyState >= 2) return;
    this.closedWith = code ?? 1005;
    this.readyState = 3;
    this.emit('close', this.closedWith, '');
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  /** The server sends a JSON event (an object) or a raw text frame. */
  reply(event: Record<string, unknown> | string): void {
    this.emit('message', typeof event === 'string' ? event : JSON.stringify(event), false);
  }

  /** The server closes the socket. */
  drop(code: number, reason = ''): void {
    this.readyState = 3;
    this.emit('close', code, reason);
  }

  /** Text frames only, in order. */
  get texts(): string[] {
    return this.sent.filter((frame): frame is string => typeof frame === 'string');
  }

  /** Binary frames only, in order. */
  get audio(): Uint8Array[] {
    return this.sent.filter((frame): frame is Uint8Array => typeof frame !== 'string');
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])])
      (fn as (...a: unknown[]) => void)(...args);
  }
}

/** A NetPort whose sockets open on the next microtask unless `autoOpen` is false. */
export function fakeNet(autoOpen = true): NetPort & { sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    fetch: () => Promise.reject(new Error('no http in these tests')),
    websocket(url, opts) {
      const socket = new FakeSocket(url, opts?.headers ?? {});
      sockets.push(socket);
      if (autoOpen) queueMicrotask(() => socket.open());
      return socket;
    },
  };
}

export interface Recorder {
  events: SttEvent[];
  usage: UsageMeter[];
  input: Start;
  abort: AbortController;
}

export function recorder(overrides: Partial<Start> = {}): Recorder {
  const events: SttEvent[] = [];
  const usage: UsageMeter[] = [];
  const abort = new AbortController();
  return {
    events,
    usage,
    abort,
    input: {
      sessionId: 'call-1',
      format: MULAW_8K,
      language: 'en-IN',
      signal: abort.signal,
      onEvent: (event) => events.push(event),
      onUsage: (meter) => usage.push(meter),
      ...overrides,
    },
  };
}

/** `ms` of μ-law speech-like bytes (not silence), 8 bytes per millisecond. */
export const speech = (ms: number) => new Uint8Array(ms * 8).fill(0x2a);

/** The final transcript texts, in order. */
export const finals = (events: readonly SttEvent[]) =>
  events.flatMap((event) =>
    event.type === 'transcript' && event.segment.stability === 'final' ? [event.segment.text] : [],
  );

/** Lets queued microtasks and immediates run. */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((done) => setImmediate(done));
}
