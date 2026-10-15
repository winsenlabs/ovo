import type { SttEvent } from '@winsendotai/ovo-contracts';
import type { OpenedStt } from '../src/human-transcriber.ts';

interface FakeSession {
  sessionId: string;
  emit(event: SttEvent): void;
  frames: Uint8Array[];
  finished: boolean;
}

/** An STT selection whose sessions the test drives. */
export function fakeStt(over: { failStart?: boolean; failWrite?: boolean } = {}) {
  const sessions: FakeSession[] = [];
  let closed = 0;
  const opened: OpenedStt = {
    stt: {
      capabilities: {} as never,
      start: async (input) => {
        if (over.failStart) throw new Error('stt unavailable');
        const session: FakeSession = {
          sessionId: input.sessionId,
          frames: [],
          finished: false,
          emit: (event) => input.onEvent(event),
        };
        sessions.push(session);
        return {
          write: async (frame) => {
            if (over.failWrite) throw new Error('socket closed');
            session.frames.push(frame);
          },
          finish: async () => void (session.finished = true),
          cancel: async () => undefined,
        };
      },
    },
    close: async () => void (closed += 1),
  };
  return { opened, sessions, closes: () => closed };
}
