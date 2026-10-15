/**
 * The operator desk's seat in a call room (Wave 17, design section 8.1). The console only knows
 * this interface; the adapter for the room server in use is loaded by provider id (`factory.ts`),
 * so a screen never names a vendor and a fake can stand in for tests and fixtures.
 */

/** What `POST /v1/desk/tickets/:id/accept` returns to join the room: short-lived and room-scoped. */
export interface RoomGrant {
  provider: string;
  serverUrl: string;
  roomName: string;
  identity: string;
  role: 'operator' | 'monitor';
  token: string;
  expiresAt: string;
}

export type RoomConnectionState =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** One caption sent by the worker over the room's data channel (topic `ovo.caption`). */
export interface RoomCaption {
  role: 'caller' | 'operator' | 'agent';
  text: string;
  final: boolean;
  at: number;
}

/** Instantaneous audio levels, 0 to 1: what the operator is sending and what they hear. */
export interface RoomLevels {
  input: number;
  output: number;
}

export interface RoomClient {
  readonly provider: string;
  connect(grant: RoomGrant): Promise<void>;
  /** Leaves the room and releases the microphone. Safe to call twice. */
  disconnect(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  /** Playback volume, 0 to 1. */
  setVolume(volume: number): void;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  onState(listener: (state: RoomConnectionState) => void): () => void;
  onCaption(listener: (caption: RoomCaption) => void): () => void;
  /** The caller's seat is in the room. False until it joins ("Connecting caller…") and if it leaves. */
  onCallerPresent(listener: (present: boolean) => void): () => void;
  /** Sampled by the UI on an animation frame; never allocates a subscription. */
  levels(): RoomLevels;
}

/** A listener list with unsubscribe, shared by the fake and the browser adapter. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}
