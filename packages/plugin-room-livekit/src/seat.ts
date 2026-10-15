import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import {
  bytesForMs,
  bytesToPcm16,
  createReframer,
  pcm16ToBytes,
  type Reframer,
} from '@winsendotai/ovo-audio';
import type {
  AudioFormat,
  RoomParticipantEvent,
  RoomSeat,
  RoomSeatStats,
} from '@winsendotai/ovo-contracts';

export interface SeatLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** What the room carries: mono PCM16 at 16 kHz, which Opus wideband covers without waste. */
export const ROOM_FORMAT: AudioFormat = Object.freeze({
  encoding: 'pcm_s16le',
  sampleRate: 16_000,
  channels: 1,
});
export const FRAME_MS = 20;
/** Audio queued toward the room beyond this is dropped (and counted), never waited for. */
const MAX_BACKLOG_MS = 300;
/** Data messages (captions) stay small: the channel is reliable and ordered. */
const MAX_DATA_BYTES = 4096;

export const roleOf = (identity: string): string =>
  identity.startsWith('op:') ? 'operator' : identity.startsWith('mon:') ? 'monitor' : 'participant';

/**
 * The server-side `caller` participant. Caller audio goes in as 20 ms frames of `format`, operator
 * audio comes out as 20 ms frames of `format`, in order, and only from `op:` participants.
 */
export class LiveKitSeat implements RoomSeat {
  private readonly source = new AudioSource(ROOM_FORMAT.sampleRate, 1, 500);
  private readonly uplink: Reframer;
  private readonly audioListeners = new Set<(frame: Uint8Array) => void>();
  private readonly participantListeners = new Set<(event: RoomParticipantEvent) => void>();
  private readonly participants = new Map<string, string>();
  private readonly readers = new Set<ReadableStreamDefaultReader<AudioFrame>>();
  private readonly connectedAt: number;
  private closedAt?: number;
  private closing?: Promise<void>;
  /** Caller audio offered, in 20 ms units of `format` (a measure of audio, not of calls). */
  private offeredIn = 0;
  private framesOut = 0;
  private droppedIn = 0;
  private droppedOut = 0;
  private readonly frameBytes: number;

  constructor(
    private readonly room: Room,
    private readonly format: AudioFormat,
    private readonly now: () => number,
    private readonly logger?: SeatLogger,
  ) {
    this.uplink = createReframer(format, ROOM_FORMAT, FRAME_MS);
    this.frameBytes = bytesForMs(format, FRAME_MS);
    this.connectedAt = now();
    room.on(RoomEvent.ParticipantConnected, (p) => this.joined(p));
    room.on(RoomEvent.ParticipantDisconnected, (p) => this.left(p.identity));
    room.on(RoomEvent.TrackSubscribed, (track, _pub, p) => this.subscribed(track, p));
    room.on(RoomEvent.Disconnected, () => void this.close());
  }

  /** Called once connected: who is already here, then the microphone track. */
  async start(): Promise<void> {
    for (const p of this.room.remoteParticipants.values()) this.joined(p);
    const track = LocalAudioTrack.createAudioTrack('caller', this.source);
    await this.room.localParticipant!.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
  }

  private joined(p: RemoteParticipant): void {
    if (this.closing || this.participants.has(p.identity)) return;
    this.participants.set(p.identity, roleOf(p.identity));
    this.emit({ kind: 'joined', identity: p.identity, role: roleOf(p.identity) });
  }

  private left(identity: string): void {
    if (!this.participants.delete(identity)) return;
    this.emit({ kind: 'left', identity, role: roleOf(identity) });
  }

  private emit(event: RoomParticipantEvent): void {
    for (const listener of this.participantListeners) this.guard(() => listener(event));
  }

  private guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.logger?.warn('room_listener_failed', { error: (error as Error).message });
    }
  }

  private subscribed(track: RemoteTrack, p: RemoteParticipant): void {
    // Only an operator's microphone is played to the caller; a monitor never is.
    if (track.kind !== TrackKind.KIND_AUDIO || roleOf(p.identity) !== 'operator') return;
    this.joined(p);
    void this.pump(track, createReframer(ROOM_FORMAT, this.format, FRAME_MS));
  }

  private async pump(track: RemoteTrack, downlink: Reframer): Promise<void> {
    let reader: ReadableStreamDefaultReader<AudioFrame> | undefined;
    try {
      // Opening the stream is a native call that fails when the track is already gone.
      reader = new AudioStream(track, {
        sampleRate: ROOM_FORMAT.sampleRate,
        numChannels: 1,
        frameSizeMs: FRAME_MS,
      }).getReader();
      this.readers.add(reader);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const frame of downlink.push(pcm16ToBytes(value.data))) this.deliver(frame);
      }
    } catch (error) {
      if (!this.closing)
        this.logger?.warn('room_audio_read_failed', { error: (error as Error).message });
    } finally {
      if (reader) this.readers.delete(reader);
    }
  }

  private deliver(frame: Uint8Array): void {
    if (this.closing) return;
    this.framesOut += 1;
    if (!this.audioListeners.size) {
      this.droppedOut += 1;
      return;
    }
    for (const listener of this.audioListeners) this.guard(() => listener(frame));
  }

  sendAudio(frame: Uint8Array): void {
    this.offeredIn += frame.byteLength / this.frameBytes;
    if (this.closing) {
      this.droppedIn += Math.ceil(frame.byteLength / this.frameBytes);
      return;
    }
    for (const bytes of this.uplink.push(frame)) {
      if (this.source.queuedDuration > MAX_BACKLOG_MS) {
        this.droppedIn += 1;
        continue;
      }
      const pcm = bytesToPcm16(bytes);
      this.source
        .captureFrame(new AudioFrame(pcm, ROOM_FORMAT.sampleRate, 1, pcm.length))
        .catch((error: Error) => {
          this.droppedIn += 1;
          if (!this.closing) this.logger?.warn('room_capture_failed', { error: error.message });
        });
    }
  }

  onOperatorAudio(listener: (frame: Uint8Array) => void): () => void {
    this.audioListeners.add(listener);
    return () => void this.audioListeners.delete(listener);
  }

  onParticipant(listener: (event: RoomParticipantEvent) => void): () => void {
    this.participantListeners.add(listener);
    // Anyone already here is reported first, in join order, so a late listener misses no one.
    for (const [identity, role] of this.participants)
      this.guard(() => listener({ kind: 'joined', identity, role }));
    return () => void this.participantListeners.delete(listener);
  }

  operatorPresent(): boolean {
    for (const role of this.participants.values()) if (role === 'operator') return true;
    return false;
  }

  sendData(topic: string, payload: Uint8Array, identities?: readonly string[]): void {
    if (payload.byteLength > MAX_DATA_BYTES)
      throw new RangeError(`Room data is limited to ${MAX_DATA_BYTES} bytes`);
    if (this.closing) return;
    this.room
      .localParticipant!.publishData(payload, {
        reliable: true,
        topic,
        ...(identities ? { destination_identities: [...identities] } : {}),
      })
      .catch((error: Error) =>
        this.logger?.warn('room_data_failed', { topic, error: error.message }),
      );
  }

  /**
   * `framesIn` is every 20 ms of caller audio offered and `droppedIn` the part of it shed, so the
   * difference went into the room. `framesOut` is every operator frame that arrived and
   * `droppedOut` the part nobody was listening for.
   */
  stats(): RoomSeatStats {
    const framesIn = Math.ceil(this.offeredIn - 1e-9);
    return {
      framesIn,
      framesOut: this.framesOut,
      droppedIn: Math.min(this.droppedIn, framesIn),
      droppedOut: this.droppedOut,
      connectedMs: (this.closedAt ?? this.now()) - this.connectedAt,
    };
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closedAt = this.now();
      for (const identity of [...this.participants.keys()]) this.left(identity);
      await Promise.allSettled([...this.readers].map((reader) => reader.cancel()));
      await this.source.close().catch(() => undefined);
      await this.room.disconnect().catch(() => undefined);
    })();
    return this.closing;
  }
}

/** Connects the seat. Unsupported formats fail before any network; an abort at any point closes it. */
export async function connectSeat(input: {
  url: string;
  token: string;
  format: AudioFormat;
  signal: AbortSignal;
  now: () => number;
  logger?: SeatLogger;
}): Promise<LiveKitSeat> {
  // createReframer inside the constructor throws for a format with no conversion.
  input.signal.throwIfAborted();
  const room = new Room();
  const seat = new LiveKitSeat(room, input.format, input.now, input.logger);
  const abort = () => void seat.close();
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    await room.connect(input.url, input.token, { autoSubscribe: true, dynacast: false });
    input.signal.throwIfAborted();
    await seat.start();
    input.signal.throwIfAborted();
  } catch (error) {
    input.signal.removeEventListener('abort', abort);
    await seat.close();
    throw error;
  }
  return seat;
}
