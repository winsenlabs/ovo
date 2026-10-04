import type { Clock, NetPort, WebSocketLike } from '@winsendotai/ovo-contracts';
import { createFixtureNet, FixtureMismatchError } from '@winsendotai/ovo-plugin-kit';
import type { SttReplayPlan } from './stt-replay-plan.ts';

type MessageListener = (data: string | Uint8Array, isBinary: boolean) => void;

/** Strict FixtureNet still validates every frame; only server delivery waits for actual caller audio. */
export function createSttReplayNet(plan: SttReplayPlan, clock: Clock) {
  const net = createFixtureNet(plan.scripts, { clock });
  const released = new Set<number>();
  const drains = new Set<() => void>();
  const pending = new Set<{
    turn: number | undefined;
    data: string | Uint8Array;
    isBinary: boolean;
  }>();
  const errors: unknown[] = [];
  const opened = new Set<number>();
  const cancelled = new Set<number>();
  const allowedCloseErrors = new Set<unknown>();
  let callerHungUp = false;
  const isCancelledTail = (step: { host: string; source: string; step: number }) =>
    [...cancelled].some((index) => {
      const script = plan.scripts[index]!;
      return (
        step.host === script.host &&
        step.source === script.source &&
        step.step >= plan.shutdownStarts[index]!
      );
    });
  const matching = (raw: string) =>
    plan.scripts.flatMap((script, index) => {
      const first = script.steps.find((step) => 'expect' in step && step.expect === 'ws-open');
      if (!first || !('expect' in first) || first.expect !== 'ws-open' || opened.has(index))
        return [];
      if (typeof first.url === 'string') return first.url === raw ? [index] : [];
      first.url.lastIndex = 0;
      return first.url.test(raw) ? [index] : [];
    });
  const port: NetPort = {
    fetch: net.fetch.bind(net),
    websocket(url, options) {
      const candidates = matching(new URL(url).href);
      if (candidates.length !== 1)
        throw new Error('fixture_unavailable: ambiguous STT replay socket');
      const index = candidates[0]!;
      const socket = net.websocket(url, options);
      opened.add(index);
      const listeners = new Set<MessageListener>();
      const queue: { turn: number | undefined; data: string | Uint8Array; isBinary: boolean }[] =
        [];
      let message = 0;
      const drain = () => {
        while (
          listeners.size &&
          queue.length &&
          (queue[0]!.turn === undefined || released.has(queue[0]!.turn!))
        ) {
          const next = queue.shift()!;
          pending.delete(next);
          for (const listener of [...listeners]) {
            try {
              listener(next.data, next.isBinary);
            } catch (cause) {
              errors.push(cause);
            }
          }
        }
      };
      drains.add(drain);
      socket.on('message', (data, isBinary) => {
        if (message >= plan.messageTurns[index]!.length)
          throw new Error('STT replay emitted an unplanned frame');
        const frame = { turn: plan.messageTurns[index]![message++], data, isBinary };
        pending.add(frame);
        queue.push(frame);
        drain();
      });
      socket.on('close', () => drains.delete(drain));
      return {
        get readyState() {
          return socket.readyState;
        },
        send: socket.send.bind(socket),
        close(code, reason) {
          const shutdownStart = plan.shutdownStarts[index];
          const remaining = net
            .pending()
            .filter(
              (step) =>
                step.host === plan.scripts[index]!.host &&
                step.source === plan.scripts[index]!.source,
            );
          const expectedCancellation =
            callerHungUp &&
            (code === undefined || code === 1000) &&
            pending.size === 0 &&
            shutdownStart !== undefined &&
            remaining.every((step) => step.step >= shutdownStart);
          const before = new Set(net.mismatches);
          try {
            socket.close(code, reason);
          } catch (cause) {
            if (
              expectedCancellation &&
              cause instanceof FixtureMismatchError &&
              !before.has(cause) &&
              net.mismatches.includes(cause)
            ) {
              cancelled.add(index);
              allowedCloseErrors.add(cause);
            } else errors.push(cause);
          }
        },
        on: ((event: string, listener: MessageListener) => {
          if (event !== 'message') return socket.on(event as 'message', listener);
          listeners.add(listener);
          queueMicrotask(drain);
          return () => {
            listeners.delete(listener);
          };
        }) as WebSocketLike['on'],
      };
    },
  };
  return {
    port,
    matches: (url: string) => matching(new URL(url).href).length > 0,
    release(turn: number) {
      released.add(turn);
      for (const drain of drains) drain();
    },
    callerHangup() {
      callerHungUp = true;
    },
    assertComplete() {
      if (!cancelled.size) net.assertComplete();
      else {
        const remaining = net.pending().filter((step) => !isCancelledTail(step));
        const mismatches = net.mismatches.filter((error) => !allowedCloseErrors.has(error));
        if (remaining.length || mismatches.length || net.listenerErrors.length)
          throw FixtureMismatchError.incomplete([
            ...remaining.map((step) => `unconsumed ${step.description}`),
            ...mismatches.map((error) => error.message),
            ...net.listenerErrors.map((error) => `listener error: ${String(error)}`),
          ]);
      }
      if (pending.size)
        throw new Error(`Fixture STT replay has ${pending.size} frames awaiting caller audio`);
      if (errors.length) throw new Error(`Fixture STT listener failed: ${String(errors[0])}`);
    },
  };
}
