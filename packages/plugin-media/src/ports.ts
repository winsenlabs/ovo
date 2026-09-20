export const MEDIA_SERVICE_KEYS = Object.freeze({
  routeResolver: 'ovo.media-route-resolver',
  gateway: 'ovo.media-gateway',
});

export interface DurableMediaRoute {
  sessionId: string;
  workerId: string;
  ownerEpoch: number;
  generation: number;
  carrierCallId?: string;
  status: string;
  terminalAt?: Date;
}

export interface MediaRouteResolver {
  authenticateSessionRoute(
    sessionId: string,
    token: string,
  ): Promise<DurableMediaRoute | undefined>;
  resolveSessionRoute(input: { carrierCallId: string }): Promise<DurableMediaRoute | undefined>;
}

export interface CarrierCallbackProjector {
  applyCarrierCallback(input: {
    provider: string;
    eventId: string;
    dialRequestId?: string;
    carrierCallId: string;
    status:
      | 'initiated'
      | 'ringing'
      | 'answered'
      | 'completed'
      | 'busy'
      | 'failed'
      | 'no_answer'
      | 'cancelled';
    occurredAt: Date;
    payload?: Record<string, unknown>;
  }): Promise<{ kind: string }>;
}

export interface MediaSessionIdentity {
  sessionId: string;
  callSid: string;
  streamSid: string;
  ownerId: string;
  ownerEpoch: number;
  generation: number;
}

export type GatewayToWorkerMessage =
  | { type: 'worker.ready'; workerId: string }
  | ({ type: 'session.open'; codec: 'audio/x-mulaw'; sampleRate: 8000 } & MediaSessionIdentity)
  | ({
      type: 'media.audio';
      payload: string;
      sequenceNumber: number;
      timestampMs: number;
    } & MediaSessionIdentity)
  | ({ type: 'media.mark'; name: string } & MediaSessionIdentity)
  | ({ type: 'media.dtmf'; digit: string } & MediaSessionIdentity)
  | ({ type: 'session.stop'; reason: string } & MediaSessionIdentity)
  | ({ type: 'session.cancel'; reason: string } & MediaSessionIdentity);

export type WorkerToGatewayMessage =
  | { type: 'worker.hello'; workerId: string; token: string }
  | ({ type: 'session.accept' } & MediaSessionIdentity)
  | ({ type: 'media.audio'; payload: string } & MediaSessionIdentity)
  | ({ type: 'media.mark'; name: string } & MediaSessionIdentity)
  | ({ type: 'media.clear' } & MediaSessionIdentity)
  | ({ type: 'session.close'; reason: string } & MediaSessionIdentity);

export interface MediaDuplex {
  readonly identity: MediaSessionIdentity;
  readonly sessionId: string;
  readonly codec: 'audio/x-mulaw';
  readonly sampleRate: 8000;
  readonly bufferedBytes: number;
  sendAudio(audio: Uint8Array, signal?: AbortSignal): Promise<void>;
  sendMark(name: string, signal?: AbortSignal): Promise<void>;
  clear(signal?: AbortSignal): Promise<void>;
  close(reason: string): Promise<void>;
  onAudio(listener: (audio: Uint8Array, timestampMs: number) => void): () => void;
  onMark(listener: (name: string) => void): () => void;
  onDtmf(listener: (digit: string) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
}
