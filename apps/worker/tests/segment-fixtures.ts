import type { VoiceMediaTransport } from '@winsendotai/ovo-contracts';

type Listener<Args extends unknown[]> = (...args: Args) => void;

/** A call's media link as segments see it: listener sets, and a record of what was sent. */
export function fakeMediaLink(sessionId = 'session-1') {
  const audio = new Set<Listener<[Uint8Array, number]>>();
  const marks = new Set<Listener<[string]>>();
  const dtmf = new Set<Listener<[string]>>();
  const closes = new Set<Listener<[string]>>();
  const sent: string[] = [];
  const closed: string[] = [];
  let isClosed = false;
  const add =
    <Args extends unknown[]>(set: Set<Listener<Args>>) =>
    (listener: Listener<Args>) => {
      set.add(listener);
      return () => void set.delete(listener);
    };
  const hangup = (reason: string) => {
    if (isClosed) return;
    isClosed = true;
    for (const listener of [...closes]) listener(reason);
  };
  const link = {
    sessionId,
    bufferedBytes: 0,
    sendAudio: async () => void sent.push('audio'),
    sendMark: async (name: string) => void sent.push(`mark:${name}`),
    clear: async () => void sent.push('clear'),
    onAudio: add(audio),
    onMark: add(marks),
    onDtmf: add(dtmf),
    onClose: add(closes),
    close: async (reason: string) => {
      closed.push(reason);
      hangup(reason);
    },
  } satisfies VoiceMediaTransport;
  return Object.assign(link, {
    sent,
    closed,
    get isClosed() {
      return isClosed;
    },
    audio: (bytes: Uint8Array, at = 0) => [...audio].forEach((listener) => listener(bytes, at)),
    dtmf: (digit: string) => [...dtmf].forEach((listener) => listener(digit)),
    mark: (name: string) => [...marks].forEach((listener) => listener(name)),
    /** The caller (or the carrier) ends the call. */
    hangup,
    listenerCount: () => audio.size + marks.size + dtmf.size + closes.size,
  });
}

export type FakeMediaLink = ReturnType<typeof fakeMediaLink>;
