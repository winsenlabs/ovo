import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { normaliseCallRoute, loadRoutingPoints, loadRoutingStatus } from './call-route-api';
import { ROUTE_EVENT_CAP } from '../types/call-route';

const request = vi.hoisted(() => vi.fn());
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  apiRequest: request,
}));
afterEach(() => request.mockReset());

describe('normaliseCallRoute', () => {
  it('reads a direct call as no route and no segments', () => {
    expect(
      normaliseCallRoute(
        { callId: 'c1', available: true, route: null, segments: [], transfers: [], human: null, callLevelCost: null },
        'c1',
      ),
    ).toMatchObject({ available: true, route: null, segments: [], events: [], eventsTruncated: false });
  });

  it('reads an installation without outcomes as not available', () => {
    expect(normaliseCallRoute({ callId: 'c1', available: false }, 'c1').available).toBe(false);
  });

  it.each([null, undefined, 'x', 7, []])('survives a malformed body %j', (body) => {
    const result = normaliseCallRoute(body, 'c9');
    expect(result).toMatchObject({ callId: 'c9', available: true, segments: [], transfers: [], events: [] });
  });

  it('keeps well-formed events in sequence order and drops the rest', () => {
    const good = { sequence: 2, at: '2026-10-20T10:00:00Z', type: 'route.node', payload: { node: 'a' } };
    const result = normaliseCallRoute(
      {
        events: [
          good,
          { ...good, sequence: 1, segment: 3 },
          { ...good, sequence: 'x' },
          { ...good, at: 5 },
          { ...good, payload: null },
          'noise',
        ],
      },
      'c',
    );
    expect(result.events.map((event) => [event.sequence, event.segment])).toEqual([[1, 3], [2, undefined]]);
  });

  it('says the events were cut at the cap, or when the API says so', () => {
    const events = Array.from({ length: ROUTE_EVENT_CAP }, (_, index) => ({
      sequence: index,
      at: '2026-10-20T10:00:00Z',
      type: 'route.node',
      payload: {},
    }));
    expect(normaliseCallRoute({ events }, 'c').eventsTruncated).toBe(true);
    expect(normaliseCallRoute({ events: events.slice(1) }, 'c').eventsTruncated).toBe(false);
    expect(normaliseCallRoute({ events: [], eventsTruncated: true }, 'c').eventsTruncated).toBe(true);
  });

  it('keeps transfer pairs whole or null on each side', () => {
    const result = normaliseCallRoute({ transfers: [{ requested: { transfer: 1 }, completed: 'x' }, 4] }, 'c');
    expect(result.transfers).toEqual([{ requested: { transfer: 1 }, completed: null }]);
  });
});

describe('routing status and points', () => {
  it('reads the flags, and anything missing as off', async () => {
    request.mockResolvedValue({ data: { enabled: true, humanQueueEnabled: true, outcomesAvailable: false } });
    expect(await loadRoutingStatus()).toEqual({
      enabled: true,
      humanQueueEnabled: true,
      transferEnabled: false,
      outcomesAvailable: false,
    });
    request.mockResolvedValue({ data: { plugins: [] } });
    expect(await loadRoutingStatus()).toMatchObject({ enabled: false, outcomesAvailable: null });
  });

  it('lists points by name, none when routing is dark, and rethrows other failures', async () => {
    request.mockResolvedValueOnce({ data: { items: [{ id: 'p1', draft: { name: 'Main line' } }, { id: 'p2' }] } });
    expect(await loadRoutingPoints()).toEqual([{ id: 'p1', name: 'Main line' }, { id: 'p2', name: 'p2' }]);
    request.mockRejectedValueOnce(new ApiError(404, 'routing_disabled', 'off'));
    expect(await loadRoutingPoints()).toEqual([]);
    request.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
    await expect(loadRoutingPoints()).rejects.toThrow('down');
  });
});
