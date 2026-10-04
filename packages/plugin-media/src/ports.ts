import type {
  AudioFormat,
  CarrierHostPorts,
  CarrierIngress,
  MediaDuplex as ContractMediaDuplex,
  PlaybackEvidence,
  VoiceMediaTransport,
} from '@winsendotai/ovo-contracts';

export const MEDIA_SERVICE_KEYS = Object.freeze({
  routeResolver: 'ovo.media-route-resolver',
  gateway: 'ovo.media-gateway',
});

/** Local structural adapter for the orchestration route. No plugin-to-plugin dependency. */
export interface DurableMediaRoute {
  sessionId: string;
  jobId: string;
  organizationId: string;
  workerId: string;
  workerEndpoint: string;
  ownerEpoch: number;
  generation: number;
  carrierId?: string;
  bindingId?: string;
  carrierCallId?: string;
  carrierStreamCallId?: string;
  status: string;
  handshakeClaimedAt?: Date;
  terminalAt?: Date;
  releasedAt?: Date;
}

export interface MediaRouteResolver {
  authenticateSessionRoute(
    sessionId: string,
    token: string,
  ): Promise<DurableMediaRoute | undefined>;
  resolveSessionRoute(input: { carrierCallId: string }): Promise<DurableMediaRoute | undefined>;
  bindCarrierCallId(input: {
    organizationId: string;
    carrierId: string;
    sessionId: string;
    carrierCallId: string;
  }): Promise<
    { kind: 'bound' | 'alias'; route: DurableMediaRoute } | { kind: 'conflict' | 'unmatched' }
  >;
  recordCarrierCallIdMismatch(input: {
    sessionId: string;
    organizationId: string;
    carrierId: string;
    dialCallId: string;
    streamCallId: string;
  }): Promise<void>;
}

export interface CarrierMount {
  ingress: CarrierIngress;
  host: CarrierHostPorts;
}

export interface MediaSessionIdentity {
  sessionId: string;
  carrierId: string;
  bindingId: string;
  carrierCallId: string;
  streamId: string;
  ownerEpoch: number;
  generation: number;
}

export type GatewayToWorkerMessage =
  | ({
      type: 'session.open';
      protocol: 2;
      format: AudioFormat;
      playbackEvidence: PlaybackEvidence;
      clearFlushesMarkers: boolean | 'unknown';
      routeToken: string;
    } & MediaSessionIdentity)
  | { type: 'media.audio'; payload: string; sequenceNumber: number; timestampMs: number }
  | { type: 'media.played'; name: string; evidence: PlaybackEvidence }
  | { type: 'media.cleared' }
  | { type: 'media.dtmf'; digit: string }
  | { type: 'call.answered-by'; value: 'human' | 'machine' | 'unknown' }
  | { type: 'session.close'; reason: string };

export type WorkerToGatewayMessage =
  | { type: 'session.accept' }
  | { type: 'session.reject'; reason: string }
  | { type: 'audio'; payload: string }
  | { type: 'mark'; name: string }
  | { type: 'clear' }
  | { type: 'session.end'; reason: string };

/** Legacy callers still name this type while the socket implementation changes. */
export type MediaDuplex = ContractMediaDuplex;

/** One-release bridge for the legacy live factory while it moves to MediaDuplex. */
export interface WorkerMediaSession extends VoiceMediaTransport {
  readonly identity: MediaSessionIdentity;
  readonly format: AudioFormat;
  readonly playbackEvidence: PlaybackEvidence;
  readonly clearFlushesMarkers: boolean | 'unknown';
  readonly codec: 'audio/x-mulaw' | 'audio/pcm';
  readonly sampleRate: 8000 | 16000;
  mark(name: string, signal?: AbortSignal): Promise<void>;
  onPlayed(listener: (name: string) => void): () => void;
  onCleared(listener: () => void): () => void;
  onAnsweredBy(listener: (value: 'human' | 'machine' | 'unknown') => void): () => void;
}
