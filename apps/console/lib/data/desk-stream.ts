import type { DeskMe, DeskStreamEvent, HumanTicketView } from '../types/desk';

export type DeskStreamStatus = 'connecting' | 'live' | 'stale' | 'closed';

/** The slice of `EventSource` the stream uses, so tests drive it without a network. */
export interface StreamSource {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(name: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface DeskStreamOptions {
  url: string;
  onEvent: (event: DeskStreamEvent) => void;
  onStatus: (status: DeskStreamStatus) => void;
  create?: (url: string) => StreamSource;
  /** No frame for this long means the server (or the path to it) is gone. */
  staleAfterMs?: number;
  retryMs?: number;
}

/** One SSE frame as a typed event; anything malformed is dropped, never thrown. */
export function parseDeskEvent(name: string, data: string): DeskStreamEvent | undefined {
  if (name === 'heartbeat') return { type: 'heartbeat' };
  if (name === 'gap') return { type: 'gap' };
  try {
    const value = JSON.parse(data) as Record<string, unknown>;
    if (name === 'ticket' && typeof value.id === 'string')
      return { type: 'ticket', ticket: value as unknown as HumanTicketView };
    if (name === 'removed' && typeof value.id === 'string') return { type: 'removed', id: value.id };
    if (name === 'me') return { type: 'me', me: value as Partial<Pick<DeskMe, 'status' | 'stats'>> };
  } catch {
    // A malformed frame must not take the stream down.
  }
  return undefined;
}

/**
 * Opens `GET /v1/desk/stream`, keeps the last event id as the resume cursor, reconnects after
 * any failure (including an HTTP error, which closes an `EventSource` for good), and reports
 * `stale` when the server stops sending frames. Returns the function that closes it.
 */
export function openDeskStream(options: DeskStreamOptions): () => void {
  const create =
    options.create ??
    ((url: string) => new EventSource(url, { withCredentials: true }) as unknown as StreamSource);
  const staleAfterMs = options.staleAfterMs ?? 45_000;
  const retryMs = options.retryMs ?? 1_000;
  let source: StreamSource | undefined;
  let cursor: string | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastFrame = Date.now();
  options.onStatus('connecting');

  const connect = () => {
    const url = new URL(options.url, 'http://desk.invalid');
    if (cursor) url.searchParams.set('cursor', cursor);
    const next = create(`${url.pathname}${url.search}`);
    source = next;
    const frame = (name: string) => (event: MessageEvent) => {
      if (closed || source !== next) return;
      lastFrame = Date.now();
      if (event.lastEventId) cursor = event.lastEventId;
      options.onStatus('live');
      const parsed = parseDeskEvent(name, String(event.data));
      if (parsed) options.onEvent(parsed);
    };
    for (const name of ['ticket', 'removed', 'me', 'gap', 'heartbeat'])
      next.addEventListener(name, frame(name));
    next.onopen = () => {
      if (closed || source !== next) return;
      lastFrame = Date.now();
      options.onStatus('live');
    };
    next.onerror = () => {
      if (closed || source !== next) return;
      next.close();
      options.onStatus('stale');
      retry = setTimeout(connect, retryMs);
    };
  };
  connect();
  const watchdog = setInterval(
    () => {
      if (!closed && Date.now() - lastFrame > staleAfterMs) options.onStatus('stale');
    },
    Math.max(1_000, staleAfterMs / 3),
  );
  return () => {
    closed = true;
    clearTimeout(retry);
    clearInterval(watchdog);
    source?.close();
    options.onStatus('closed');
  };
}
