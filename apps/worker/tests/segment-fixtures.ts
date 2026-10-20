import type { VoiceMediaTransport } from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { handoffMediaClose } from '../src/router-graph.ts';
import type { SegmentMediaLease } from '../src/segment-media.ts';

type Listener<Args extends unknown[]> = (...args: Args) => void;

/** A call's media link as segments see it: listener sets, and a record of what was sent. */
export function fakeMediaLink(sessionId = 'session-1') {
  const audio = new Set<Listener<[Uint8Array, number]>>();
  const marks = new Set<Listener<[string]>>();
  const dtmf = new Set<Listener<[string]>>();
  const closes = new Set<Listener<[string]>>();
  const sent: string[] = [];
  /** The bytes of every `sendAudio`, in order (human bridge tests read them). */
  const frames: Uint8Array[] = [];
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
    sendAudio: async (bytes: Uint8Array) => {
      sent.push('audio');
      frames.push(bytes);
    },
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
    frames,
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

/**
 * `fakeSegment`'s `native` option for a routed call: its hang-up wrapped as the routed composer
 * wraps it (it runs only when `mayEndCall`), recorded in `hangUps`.
 */
export function nativeEngine(mayEndCall: () => boolean, hangUps: string[]) {
  const hangUp = handoffMediaClose(mayEndCall, async (reason) => void hangUps.push(reason));
  return { native: { hangUp } };
}

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
 * `fail` makes start throw. With `native`, disposing it closes its media as the native engine's
 * dispose always does, started or not, unless it already ended itself: its hang-up first, then its
 * lease, however the hang-up went.
 */
export function fakeSegment(
  name: string,
  journal: SegmentJournal,
  lease: Pick<SegmentMediaLease, 'onAudio' | 'onDtmf' | 'close'>,
  options: {
    releaseId?: string;
    agentId?: string;
    fail?: boolean;
    native?: { hangUp(reason: string): Promise<void> };
  } = {},
) {
  let unsubscribe: (() => void)[] = [];
  let started = false;
  // The engine closes its media once: when it ends itself (`complete`) or when it is disposed.
  let mediaClosed = false;
  const heard: string[] = [];
  const closeReasons: string[] = [];
  const closeMedia = async (reason: string) => {
    mediaClosed = true;
    if (!options.native) return lease.close(reason);
    try {
      await options.native.hangUp(reason);
    } finally {
      await lease.close(reason);
    }
  };
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
      if (options.native && !mediaClosed) await closeMedia(reason);
      if (closeReasons.length > 1 || !started) return undefined;
      journal.log(`${name}.close:${reason}`);
      for (const stop of unsubscribe.splice(0)) stop();
      journal.detach(name);
      return undefined;
    },
    /** The engine's behaviour completed: it closes its media, as the native engine's stop does. */
    complete: (reason = 'behavior_completed') => closeMedia(reason),
  };
  return segment;
}

/** `fakeSegment` with a release config and a voice: `speak` sends audio as its engine would. */
export function agentSegment(
  name: string,
  journal: SegmentJournal,
  lease: SegmentMediaLease,
  options: Parameters<typeof fakeSegment>[3] & { releaseId: string; agentId: string },
) {
  const segment = fakeSegment(name, journal, lease, options);
  Object.assign(segment.release, {
    config: { language: 'en', variables: { type: 'object', additionalProperties: true } },
  });
  return Object.assign(segment, {
    speak: () => lease.sendAudio(new Uint8Array(160).fill(7)),
  });
}
