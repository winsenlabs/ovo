import type { AudioFormat } from '../audio.ts';

/**
 * Capability `ovo.media-room` (process scope). A room is where the caller's audio and an operator's
 * meet. Provided by a room plugin, absent unless the room feature is composed; host code speaks of
 * rooms and seats and never names the server behind them.
 */
export interface MediaRoomProvider {
  /** The server family's id; only the plugin and the browser adapter know what it means. */
  readonly provider: string;
  /** What browsers connect to. */
  readonly publicUrl: string;
  health(signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Idempotent. */
  ensureRoom(input: {
    name: string;
    maxParticipants: number;
    emptyTimeoutSeconds: number;
  }): Promise<void>;
  /** Idempotent: a missing room is deleted. */
  deleteRoom(name: string): Promise<void>;
  /** Short-TTL join token scoped to one room: audio publish/subscribe only, no data publish, no admin. */
  mintToken(input: {
    room: string;
    identity: string;
    name: string;
    role: 'operator' | 'monitor';
    ttlSeconds: number;
  }): Promise<{ token: string; expiresAt: string }>;
  removeParticipant(room: string, identity: string): Promise<void>;
  /** The server-side `caller` participant. */
  join(input: {
    room: string;
    identity: string;
    format: AudioFormat;
    signal: AbortSignal;
  }): Promise<RoomSeat>;
}

export interface RoomParticipantEvent {
  kind: 'joined' | 'left';
  identity: string;
  role: string;
}
export interface RoomSeatStats {
  framesIn: number;
  framesOut: number;
  droppedIn: number;
  droppedOut: number;
  connectedMs: number;
}
export interface RoomSeat {
  /** Caller audio into the room, 20 ms frames in `format`. Never blocks; counts what it drops. */
  sendAudio(frame: Uint8Array): void;
  /** Operator audio, decoded to `format`, 20 ms frames, from the operator participant only. Returns the unsubscribe. */
  onOperatorAudio(listener: (frame: Uint8Array) => void): () => void;
  /** Participants already present are reported `joined` to a new listener first, in join order. */
  onParticipant(listener: (event: RoomParticipantEvent) => void): () => void;
  operatorPresent(): boolean;
  /** Captions etc. to given identities (default all), reliable. At most 4 KiB. */
  sendData(topic: string, payload: Uint8Array, identities?: readonly string[]): void;
  stats(): RoomSeatStats;
  /** Idempotent. */
  close(): Promise<void>;
}
