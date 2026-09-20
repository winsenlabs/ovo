import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DurableMediaRoute, GatewayToWorkerMessage, MediaSessionIdentity } from './ports.ts';
import type { WebSocketPeer } from './websocket-peer.ts';

export interface MediaGatewayConfig {
  publicBaseUrl: string;
  twilioAuthToken: string;
  workerToken: string;
  host?: string;
  port?: number;
  maxMessageBytes?: number;
  maxAudioFrameBytes?: number;
  maxBufferedBytes?: number;
  maxPendingFrames?: number;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  drainTimeoutMs?: number;
  httpHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
}

export interface WorkerConnection {
  peer: WebSocketPeer;
  workerId?: string;
  authenticated: boolean;
  timer: NodeJS.Timeout;
}

export interface CarrierSession {
  peer: WebSocketPeer;
  route?: DurableMediaRoute;
  identity?: MediaSessionIdentity;
  worker?: WorkerConnection;
  accepted: boolean;
  pending: GatewayToWorkerMessage[];
  lastSequence: number;
  timer: NodeJS.Timeout;
}
