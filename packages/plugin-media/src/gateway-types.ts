import type { CarrierHostPorts, CarrierIngress } from '@winsendotai/ovo-contracts';

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
}
