import type { MediaRoomProvider, RoomSeat } from '../src/human-contract.ts';

/** A room seat the test drives: the operator's side is `operatorAudio` / `join` / `leave`. */
export class FakeSeat implements RoomSeat {
  readonly sent: Uint8Array[] = [];
  readonly data: { topic: string; payload: string; identities?: readonly string[] }[] = [];
  closed = false;
  private present = false;
  private audio = new Set<(frame: Uint8Array) => void>();
  private participants = new Set<
    (event: { kind: 'joined' | 'left'; identity: string; role: string }) => void
  >();
  connectedMs = 0;

  constructor(
    readonly room: string,
    readonly identity: string,
    operator: string | undefined,
  ) {
    this.present = operator !== undefined;
  }

  sendAudio(frame: Uint8Array): void {
    this.sent.push(frame);
  }
  onOperatorAudio(listener: (frame: Uint8Array) => void): () => void {
    this.audio.add(listener);
    return () => void this.audio.delete(listener);
  }
  onParticipant(
    listener: (event: { kind: 'joined' | 'left'; identity: string; role: string }) => void,
  ): () => void {
    this.participants.add(listener);
    return () => void this.participants.delete(listener);
  }
  operatorPresent(): boolean {
    return this.present;
  }
  sendData(topic: string, payload: Uint8Array, identities?: readonly string[]): void {
    this.data.push({
      topic,
      payload: new TextDecoder().decode(payload),
      ...(identities ? { identities } : {}),
    });
  }
  stats() {
    return {
      ...{ framesIn: 0, framesOut: this.sent.length, droppedIn: 0, droppedOut: 0 },
      connectedMs: this.connectedMs,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
  }

  /** The operator's microphone: a frame the bridge should send to the caller. */
  operatorAudio(frame: Uint8Array): void {
    for (const listener of [...this.audio]) listener(frame);
  }
  join(identity: string): void {
    this.present = true;
    for (const listener of [...this.participants])
      listener({ kind: 'joined', identity, role: 'operator' });
  }
  leave(identity: string): void {
    this.present = false;
    for (const listener of [...this.participants])
      listener({ kind: 'left', identity, role: 'operator' });
  }
}

export class FakeRooms implements MediaRoomProvider {
  readonly provider = 'fake';
  readonly publicUrl = 'wss://rooms.example.test';
  healthy = true;
  joinFailures = 0;
  readonly seats: FakeSeat[] = [];
  readonly deleted: string[] = [];
  /** Operators already in a room before the worker's seat joins. */
  readonly present = new Map<string, string>();

  async health() {
    return this.healthy ? ({ ok: true } as const) : ({ ok: false, reason: 'down' } as const);
  }
  async ensureRoom(): Promise<void> {}
  async deleteRoom(name: string): Promise<void> {
    this.deleted.push(name);
  }
  async removeParticipant(): Promise<void> {}
  async mintToken() {
    return { token: 'fake-token', expiresAt: new Date(0).toISOString() };
  }
  async join(input: { room: string; identity: string }): Promise<RoomSeat> {
    if (this.joinFailures > 0) {
      this.joinFailures -= 1;
      throw new Error('room unreachable');
    }
    const seat = new FakeSeat(input.room, input.identity, this.present.get(input.room));
    this.seats.push(seat);
    return seat;
  }
  seat(): FakeSeat {
    return this.seats.at(-1)!;
  }
}
