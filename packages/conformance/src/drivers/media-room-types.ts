import type { AudioFormat, MediaRoomProvider } from '@winsendotai/ovo-contracts';

/** The token fields a room must grant an operator, as a provider-neutral reading of its signed claims. */
export interface RoomTokenClaims {
  room: string;
  identity: string;
  name?: string;
  issuedAtMs: number;
  expiresAtMs: number;
  /** `roomJoin` for `room`. */
  canJoin: boolean;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
  /** Sources the token may publish, when it restricts them (`microphone`). */
  publishSources?: readonly string[];
  roomAdmin: boolean;
  roomCreate: boolean;
  roomList: boolean;
  hidden: boolean;
}

export interface RoomDataMessage {
  topic: string;
  payload: Uint8Array;
  from: string;
}

/** A headless participant, standing in for an operator's browser. */
export interface RoomParticipantClient {
  readonly identity: string;
  readonly connected: boolean;
  /** One 20 ms frame in the client's format. Throws when the token cannot publish. */
  sendAudio(frame: Uint8Array): void;
  /** Frames from every other participant, with who sent them. */
  onAudio(listener: (frame: Uint8Array, from: string) => void): () => void;
  /** Throws when the token cannot publish data. */
  sendData(topic: string, payload: Uint8Array): void;
  onData(listener: (message: RoomDataMessage) => void): () => void;
  onDisconnected(listener: (reason: string) => void): () => void;
  close(): Promise<void>;
}

/** What `describeMediaRoom` needs from a room implementation and a way to be a participant in it. */
export interface MediaRoomUnderTest {
  room: MediaRoomProvider;
  /** Verifies the token's signature with the server secret and reads its claims. Rejects a forged one. */
  claimsOf(token: string): Promise<RoomTokenClaims>;
  /** Joins `room` with a minted token, the way a browser would. Rejects when the token is refused. */
  connect(input: {
    token: string;
    room: string;
    format: AudioFormat;
  }): Promise<RoomParticipantClient>;
  close(): Promise<void>;
}

export type MediaRoomFactory = () => MediaRoomUnderTest | Promise<MediaRoomUnderTest>;
