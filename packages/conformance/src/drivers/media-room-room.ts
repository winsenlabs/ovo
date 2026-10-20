import type { RoomParticipantEvent, RoomSeat, RoomSeatStats } from '@winsendotai/ovo-contracts';
import type {
  RoomDataMessage,
  RoomParticipantClient,
  RoomTokenClaims,
} from './media-room-types.ts';

const FRAME_MS = 20;
/** A second of frames: past it a publisher's oldest frame is dropped and counted. */
const MAX_QUEUED_FRAMES = 50;
const MAX_DATA_BYTES = 4_096;

export interface FakeParticipant {
  readonly identity: string;
  readonly claims?: RoomTokenClaims;
  outbox: Uint8Array[];
}

/** One room of the fake server: participants, a 20 ms pacer and the seat's view of them. */
export class FakeRoom {
  private readonly entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setInterval>;
  private seatEntry?: SeatEntry;

  constructor(
    readonly name: string,
    private readonly max: number,
  ) {}

  private add(entry: Entry): void {
    if (this.entries.size >= this.max) throw new Error(`Room ${this.name} is full`);
    this.entries.set(entry.identity, entry);
    this.timer ??= setInterval(() => this.tick(), FRAME_MS);
    this.timer.unref?.();
  }

  private remove(entry: Entry): void {
    if (this.entries.get(entry.identity) !== entry) return;
    this.entries.delete(entry.identity);
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private tick(): void {
    for (const from of [...this.entries.values()]) {
      const frame = from.outbox.shift();
      if (!frame) continue;
      for (const to of this.entries.values()) {
        if (to === from) continue;
        if (to instanceof SeatEntry) {
          if (from instanceof ClientEntry && from.claims.canPublish) to.seat.hear(frame);
        } else if ((to as ClientEntry).claims.canSubscribe)
          (to as ClientEntry).hear(frame, from.identity);
      }
    }
  }

  enqueue(from: Entry, frame: Uint8Array): void {
    from.outbox.push(Uint8Array.from(frame));
    if (from.outbox.length <= MAX_QUEUED_FRAMES) return;
    from.outbox.shift();
    if (from instanceof SeatEntry) from.seat.droppedIn += 1;
    else if (this.seatEntry) this.seatEntry.seat.droppedOut += 1;
  }

  admit(claims: RoomTokenClaims): RoomParticipantClient {
    this.disconnect(claims.identity, 'duplicate_identity');
    const entry = new ClientEntry(this, claims);
    this.add(entry);
    this.seatEntry?.seat.announce({
      kind: 'joined',
      identity: claims.identity,
      role: claims.canPublish ? 'operator' : 'monitor',
    });
    return entry.client;
  }

  seat(identity: string, signal: AbortSignal): RoomSeat {
    this.disconnect(identity, 'duplicate_identity');
    const entry = new SeatEntry(this, identity);
    this.add(entry);
    this.seatEntry = entry;
    signal.addEventListener('abort', () => void entry.seat.close(), { once: true });
    return entry.seat;
  }

  clients(): ClientEntry[] {
    return [...this.entries.values()].filter((e): e is ClientEntry => e instanceof ClientEntry);
  }

  /** Delivers a data message to the named identities, or everyone who may subscribe. */
  sendData(from: Entry, topic: string, payload: Uint8Array, only?: readonly string[]): void {
    if (payload.byteLength > MAX_DATA_BYTES)
      throw new RangeError(`Data messages are at most ${MAX_DATA_BYTES} bytes`);
    const copy = Uint8Array.from(payload);
    queueMicrotask(() => {
      for (const to of this.clients())
        if (to !== from && to.claims.canSubscribe && (!only || only.includes(to.identity)))
          to.hearData({ topic, payload: copy, from: from.identity });
    });
  }

  disconnect(identity: string, reason: string): void {
    const entry = this.entries.get(identity);
    if (!entry) return;
    this.remove(entry);
    if (entry instanceof ClientEntry) {
      entry.drop(reason);
      this.seatEntry?.seat.announce({
        kind: 'left',
        identity,
        role: entry.claims.canPublish ? 'operator' : 'monitor',
      });
    } else (entry as SeatEntry).seat.closeQuietly();
  }

  shutdown(reason: string): void {
    for (const identity of [...this.entries.keys()]) this.disconnect(identity, reason);
  }

  leave(entry: Entry): void {
    this.disconnect(entry.identity, 'left');
  }
}

abstract class Entry implements FakeParticipant {
  outbox: Uint8Array[] = [];
  abstract readonly identity: string;
}

class ClientEntry extends Entry {
  readonly identity: string;
  connected = true;
  private audio = new Set<(frame: Uint8Array, from: string) => void>();
  private data = new Set<(message: RoomDataMessage) => void>();
  private gone = new Set<(reason: string) => void>();
  readonly client: RoomParticipantClient;

  constructor(
    private readonly room: FakeRoom,
    readonly claims: RoomTokenClaims,
  ) {
    super();
    this.identity = claims.identity;
    const entry = this;
    this.client = {
      identity: claims.identity,
      get connected() {
        return entry.connected;
      },
      sendAudio(frame) {
        if (!entry.connected) throw new Error('Participant is disconnected');
        if (!claims.canPublish) throw new Error('Token does not allow publishing');
        entry.room.enqueue(entry, frame);
      },
      onAudio(listener) {
        entry.audio.add(listener);
        return () => void entry.audio.delete(listener);
      },
      sendData(topic, payload) {
        if (!entry.connected) throw new Error('Participant is disconnected');
        if (!claims.canPublishData) throw new Error('Token does not allow publishing data');
        entry.room.sendData(entry, topic, payload);
      },
      onData(listener) {
        entry.data.add(listener);
        return () => void entry.data.delete(listener);
      },
      onDisconnected(listener) {
        entry.gone.add(listener);
        return () => void entry.gone.delete(listener);
      },
      async close() {
        if (entry.connected) entry.room.leave(entry);
      },
    };
  }

  hear(frame: Uint8Array, from: string): void {
    for (const listener of this.audio) listener(Uint8Array.from(frame), from);
  }

  hearData(message: RoomDataMessage): void {
    for (const listener of this.data) listener(message);
  }

  drop(reason: string): void {
    this.connected = false;
    for (const listener of this.gone) listener(reason);
  }
}

class SeatEntry extends Entry {
  readonly seat: FakeSeat;
  constructor(
    readonly room: FakeRoom,
    readonly identity: string,
  ) {
    super();
    this.seat = new FakeSeat(this);
  }
}

class FakeSeat implements RoomSeat {
  framesIn = 0;
  framesOut = 0;
  droppedIn = 0;
  droppedOut = 0;
  private closed = false;
  private readonly startedAt = Date.now();
  private endedAt?: number;
  private audio = new Set<(frame: Uint8Array) => void>();
  private people = new Set<(event: RoomParticipantEvent) => void>();

  constructor(private readonly entry: SeatEntry) {}

  sendAudio(frame: Uint8Array): void {
    if (this.closed) return;
    this.framesIn += 1;
    this.entry.room.enqueue(this.entry, frame);
  }

  hear(frame: Uint8Array): void {
    if (this.closed) return;
    this.framesOut += 1;
    for (const listener of this.audio) listener(Uint8Array.from(frame));
  }

  onOperatorAudio(listener: (frame: Uint8Array) => void): () => void {
    this.audio.add(listener);
    return () => void this.audio.delete(listener);
  }

  onParticipant(listener: (event: RoomParticipantEvent) => void): () => void {
    this.people.add(listener);
    for (const client of this.entry.room.clients())
      listener({
        kind: 'joined',
        identity: client.identity,
        role: client.claims.canPublish ? 'operator' : 'monitor',
      });
    return () => void this.people.delete(listener);
  }

  announce(event: RoomParticipantEvent): void {
    if (this.closed) return;
    for (const listener of this.people) listener(event);
  }

  operatorPresent(): boolean {
    return this.entry.room.clients().some((client) => client.claims.canPublish);
  }

  sendData(topic: string, payload: Uint8Array, identities?: readonly string[]): void {
    if (payload.byteLength > MAX_DATA_BYTES)
      throw new RangeError(`Data messages are at most ${MAX_DATA_BYTES} bytes`);
    if (this.closed) return;
    this.entry.room.sendData(this.entry, topic, payload, identities);
  }

  stats(): RoomSeatStats {
    return {
      framesIn: this.framesIn,
      framesOut: this.framesOut,
      droppedIn: this.droppedIn,
      droppedOut: this.droppedOut,
      connectedMs: (this.endedAt ?? Date.now()) - this.startedAt,
    };
  }

  /** The room went away under the seat: nothing more is delivered. */
  closeQuietly(): void {
    if (this.closed) return;
    this.closed = true;
    this.endedAt = Date.now();
    this.audio.clear();
    this.people.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.entry.room.leave(this.entry);
    this.closeQuietly();
  }
}
