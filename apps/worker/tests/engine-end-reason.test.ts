import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { EndReason } from '@winsendotai/ovo-contracts';
import { WebSocket } from '@winsendotai/ovo-plugin-media';
import { endReasonKeeping } from '../src/worker-media-bootstrap.ts';
import { WorkerMediaLink } from '../src/worker-media-server.ts';
import { mediaRuntimeFixture, mediaSessionOpen } from './media-runtime-fixtures.ts';

function link() {
  const gateway = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (_value: string, callback?: () => void) => callback?.(),
    close: vi.fn(),
  });
  return new WorkerMediaLink(
    mediaSessionOpen(mediaRuntimeFixture().route),
    gateway as unknown as WebSocket,
  );
}

/** The carrier's stream stop, as the gateway forwards it after the hang-up. */
const carrierStop = (media: WorkerMediaLink) =>
  media.receive({ type: 'session.close', reason: 'carrier stream-ended' });

describe("an agent-ended call keeps the engine's end reason (N2)", () => {
  it('a carrier stop is still the caller hanging up when the worker is not ending the call', () => {
    const media = link();
    carrierStop(media);
    expect(media.closedReason).toBe('caller_hangup');
  });

  it('Maya calls: the stop caused by hanging up after the goodbye is not caller_hangup', () => {
    const media = link();
    const closed: string[] = [];
    media.onClose((reason) => closed.push(reason));
    media.endingWith('behavior_completed');
    carrierStop(media);
    expect(media.closedReason).toBe('behavior_completed');
    expect(closed).toEqual(['behavior_completed']);
  });

  it('marks the link before the hang-up and forgets it once the session is disposed', async () => {
    const { route, job } = mediaRuntimeFixture();
    const media = link();
    let beforeClose!: (reason: EndReason) => Promise<void>;
    let open!: ReadonlyMap<string, WorkerMediaLink>;
    const order: string[] = [];
    const disposed = vi.fn();
    const factory = endReasonKeeping((links) => {
      open = links;
      beforeClose = async (reason) => {
        links.get(route.sessionId)?.endingWith(reason);
        order.push('hangup');
        // The carrier hangs up and its stream stop comes back before the engine closes media.
        carrierStop(media);
      };
      return { create: async () => ({ dispose: async () => disposed() }) };
    });
    const session = await factory.create({ job, route, media });
    expect([...open.keys()]).toEqual([route.sessionId]);
    await beforeClose('max_duration');
    expect(order).toEqual(['hangup']);
    expect(media.closedReason).toBe('max_duration');
    await session.dispose('max_duration');
    expect(disposed).toHaveBeenCalledOnce();
    expect(open.size).toBe(0);
  });

  it('forgets a link whose session failed to open', async () => {
    const { route, job } = mediaRuntimeFixture();
    let open!: ReadonlyMap<string, WorkerMediaLink>;
    const factory = endReasonKeeping((links) => {
      open = links;
      return {
        create: async () => {
          throw new Error('compose failed');
        },
      };
    });
    await expect(factory.create({ job, route, media: link() })).rejects.toThrow('compose failed');
    expect(open.size).toBe(0);
  });
});
