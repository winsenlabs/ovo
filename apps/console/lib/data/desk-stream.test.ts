import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDeskStream, parseDeskEvent, type StreamSource } from './desk-stream';
import type { DeskStreamEvent } from '../types/desk';

class FakeSource implements StreamSource {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private handlers = new Map<string, (event: MessageEvent) => void>();
  constructor(readonly url: string) {}
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.handlers.set(name, listener);
  }
  close() {
    this.closed = true;
  }
  send(name: string, data: unknown, id?: string) {
    this.handlers.get(name)?.({ data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId: id ?? '' } as MessageEvent);
  }
}

describe('parseDeskEvent', () => {
  it('types each frame and drops malformed ones', () => {
    expect(parseDeskEvent('removed', '{"id":"t1"}')).toEqual({ type: 'removed', id: 't1' });
    expect(parseDeskEvent('ticket', '{"id":"t1","version":2}')).toMatchObject({ type: 'ticket' });
    expect(parseDeskEvent('me', '{"status":"AWAY"}')).toEqual({ type: 'me', me: { status: 'AWAY' } });
    expect(parseDeskEvent('heartbeat', '{}')).toEqual({ type: 'heartbeat' });
    expect(parseDeskEvent('gap', '')).toEqual({ type: 'gap' });
    expect(parseDeskEvent('ticket', 'not json')).toBeUndefined();
    expect(parseDeskEvent('ticket', '{"nope":1}')).toBeUndefined();
    expect(parseDeskEvent('other', '{}')).toBeUndefined();
  });
});

describe('openDeskStream', () => {
  const sources: FakeSource[] = [];
  const create = (url: string) => {
    const source = new FakeSource(url);
    sources.push(source);
    return source;
  };
  beforeEach(() => {
    sources.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('reports live on open, delivers events and resumes from the last id after an error', () => {
    const events: DeskStreamEvent[] = [];
    const statuses: string[] = [];
    const close = openDeskStream({
      url: '/api/v1/desk/stream',
      onEvent: (event) => events.push(event),
      onStatus: (status) => statuses.push(status),
      create,
      retryMs: 500,
    });
    expect(sources[0]!.url).toBe('/api/v1/desk/stream');
    sources[0]!.onopen?.(new Event('open'));
    sources[0]!.send('ticket', { id: 't1', version: 1 }, '41');
    sources[0]!.send('removed', { id: 't1' }, '42');
    expect(events.map((event) => event.type)).toEqual(['ticket', 'removed']);
    sources[0]!.onerror?.(new Event('error'));
    expect(sources[0]!.closed).toBe(true);
    expect(statuses.at(-1)).toBe('stale');
    vi.advanceTimersByTime(500);
    expect(sources).toHaveLength(2);
    expect(sources[1]!.url).toBe('/api/v1/desk/stream?cursor=42');
    sources[1]!.onopen?.(new Event('open'));
    expect(statuses.at(-1)).toBe('live');
    close();
    expect(sources[1]!.closed).toBe(true);
    expect(statuses.at(-1)).toBe('closed');
  });

  it('ignores a malformed frame without dropping the stream', () => {
    const events: DeskStreamEvent[] = [];
    openDeskStream({ url: '/s', onEvent: (e) => events.push(e), onStatus: () => undefined, create });
    sources[0]!.send('ticket', '{broken');
    sources[0]!.send('heartbeat', '{}');
    expect(events).toEqual([{ type: 'heartbeat' }]);
  });

  it('turns stale when the server goes quiet, and live again on the next frame', () => {
    const statuses: string[] = [];
    openDeskStream({
      url: '/s',
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
      create,
      staleAfterMs: 3_000,
    });
    sources[0]!.onopen?.(new Event('open'));
    vi.advanceTimersByTime(5_000);
    expect(statuses.at(-1)).toBe('stale');
    sources[0]!.send('heartbeat', '{}');
    expect(statuses.at(-1)).toBe('live');
  });

  it('never delivers from a superseded connection', () => {
    const events: DeskStreamEvent[] = [];
    openDeskStream({ url: '/s', onEvent: (e) => events.push(e), onStatus: () => undefined, create, retryMs: 1 });
    const first = sources[0]!;
    first.onerror?.(new Event('error'));
    vi.advanceTimersByTime(1);
    first.send('heartbeat', '{}');
    expect(events).toEqual([]);
  });
});
