import type { VoiceMediaTransport } from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { SegmentMediaLease } from '../src/segment-media.ts';

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

/** What the fake segments did, in order, and how many engines were attached at once. */
export class SegmentJournal {
  readonly entries: string[] = [];
  private attached = new Set<string>();
  maxAttached = 0;

  log(entry: string): void {
    this.entries.push(entry);
  }
  attach(name: string): void {
    this.attached.add(name);
    this.maxAttached = Math.max(this.maxAttached, this.attached.size);
    this.log(`${name}.start`);
  }
  detach(name: string): void {
    this.attached.delete(name);
  }
}

/**
 * A composed segment whose engine, once started, hears its lease and can end like the native
 * engine: by closing its media first (`complete`). `close` disposes it (journaled once started);
 * `fail` makes start throw.
 */
export function fakeSegment(
  name: string,
  journal: SegmentJournal,
  lease: Pick<SegmentMediaLease, 'onAudio' | 'onDtmf' | 'close'>,
  options: { releaseId?: string; agentId?: string; fail?: boolean } = {},
) {
  let unsubscribe: (() => void)[] = [];
  let started = false;
  const heard: string[] = [];
  const closeReasons: string[] = [];
  const segment = {
    release: {
      id: options.releaseId ?? `release-${name}`,
      agentId: options.agentId ?? `agent-${name}`,
    } as ReleaseRecord,
    engine: {} as never,
    composition: {} as never,
    heard,
    closeReasons,
    start: async () => {
      if (options.fail) throw new Error(`${name} failed to start`);
      journal.attach(name);
      started = true;
      unsubscribe = [
        lease.onAudio((bytes) => heard.push(`a${bytes[0]}`)),
        lease.onDtmf((digit) => heard.push(`d${digit}`)),
      ];
    },
    close: async (reason: string) => {
      closeReasons.push(reason);
      if (closeReasons.length > 1 || !started) return undefined;
      journal.log(`${name}.close:${reason}`);
      for (const stop of unsubscribe.splice(0)) stop();
      journal.detach(name);
      return undefined;
    },
    /** The engine's behaviour completed: it closes its media, as the native engine's stop does. */
    complete: (reason = 'behavior_completed') => lease.close(reason),
  };
  return segment;
}
