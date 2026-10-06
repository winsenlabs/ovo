import type { CarrierHostPorts, CarrierIngress, Logger } from '@winsendotai/ovo-contracts';

export interface MediaGatewayConfig {
  publicBaseUrl: string;
  workerToken: string;
  ingresses: readonly CarrierIngress[];
  hostFor(carrierId: string, bindingId: string): CarrierHostPorts;
  host?: string;
  port?: number;
  maxMessageBytes?: number;
  maxAudioFrameBytes?: number;
  maxBufferedBytes?: number;
  maxPendingFrames?: number;
  preAcceptBufferMs?: number;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  drainTimeoutMs?: number;
  /** Defaults to a JSON-lines logger at OVO_LOG_LEVEL. */
  logger?: Logger;
  /** OBS-12: the host's live-path state for a token-protected `/health?verbose=1`. */
  health?: GatewayHealthHook;
}

export interface GatewayHealthHook {
  /** Bearer token for verbose health; without one, verbose health is refused. */
  token?: string;
  verbose(): Promise<Record<string, unknown>>;
  /** Every closed carrier session's reason, for close-reason and timeout counts. */
  sessionClosed?(reason: string): void;
}
