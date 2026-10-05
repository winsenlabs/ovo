import type { CarrierMediaEvent, Logger, MediaCommand } from '@winsendotai/ovo-contracts';
import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import WebSocket from 'ws';
import { PreAcceptBuffer } from './pre-accept.ts';
import type {
  GatewayToWorkerMessage,
  MediaRouteResolver,
  MediaSessionIdentity,
  WorkerToGatewayMessage,
} from './ports.ts';
import type { AcceptedCarrierUpgrade } from './upgrade.ts';
import {
  resolveWorkerRoute,
  type WorkerDialer,
  type WorkerLink,
  type WorkerLinkEvents,
} from './worker-dialer.ts';

type MediaMessage = Exclude<GatewayToWorkerMessage, { type: 'session.open' | 'session.close' }>;
type WorkerOutput = Exclude<WorkerToGatewayMessage, { type: 'session.accept' | 'session.reject' }>;

export interface SessionBridgeOptions {
  accepted: AcceptedCarrierUpgrade;
  resolver: MediaRouteResolver;
  dialer: Pick<WorkerDialer, 'connect'>;
  preAcceptBufferMs?: number;
  maxPendingEvents?: number;
  maxAudioFrameBytes?: number;
  maxBufferedBytes?: number;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  logger?: Logger;
  onStarted?(identity: MediaSessionIdentity): void;
  /** Call/stream IDs from carrier start, so a failed route names its call; all IDs once routed. */
  onClosed?(reason: string, identity: Partial<MediaSessionIdentity>): void;
}

/** A carrier socket and one worker link; ownership is checked before any audio is forwarded. */
export class SessionBridge {
  private readonly socket: WebSocket;
  private readonly limits: Required<
    Pick<
      SessionBridgeOptions,
      | 'preAcceptBufferMs'
      | 'maxPendingEvents'
      | 'maxAudioFrameBytes'
      | 'maxBufferedBytes'
      | 'handshakeTimeoutMs'
      | 'idleTimeoutMs'
    >
  >;
  private buffer?: PreAcceptBuffer<MediaMessage>;
  private link?: WorkerLink;
  private identity: Partial<MediaSessionIdentity> = {};
  private log: Logger;
  private started = false;
  private accepted = false;
  private closed = false;
  private lastSequence = -1;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly connectAbort = new AbortController();

  constructor(private readonly options: SessionBridgeOptions) {
    this.socket = options.accepted.socket;
    this.log = (options.logger ?? createLogger({ service: 'media-gateway' })).child({
      carrierId: options.accepted.ingress.carrierId,
      bindingId: options.accepted.bindingId,
    });
    this.limits = {
      preAcceptBufferMs: options.preAcceptBufferMs ?? 3_000,
      maxPendingEvents: options.maxPendingEvents ?? 1_024,
      maxAudioFrameBytes: options.maxAudioFrameBytes ?? 8 * 1024,
      maxBufferedBytes: options.maxBufferedBytes ?? 256 * 1024,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
    };
    this.socket.on('message', (data, isBinary) => {
      try {
        if (isBinary) throw new Error('carrier media frame must be JSON text');
        if (this.accepted) this.touch();
        for (const event of options.accepted.codec.decode(data.toString()))
          this.carrierEvent(event);
      } catch (error) {
        this.fail('carrier_frame_rejected', error, 'carrier media protocol failed');
      }
    });
    // A lost transport may be followed by a carrier continuation at generation + 1.
    // Closing the worker link starts its resume window; session.close would end the call.
    this.socket.on('close', () => this.close('carrier socket closed', false));
    this.socket.on('error', (error) => {
      if (!this.closed) this.log.warn('carrier_socket_error', errorFields(error));
      this.close('carrier socket failed', false);
    });
    this.timer = setTimeout(
      () => this.close('carrier start timeout'),
      this.limits.handshakeTimeoutMs,
    );
    this.timer.unref?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private touch(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close('media idle timeout'), this.limits.idleTimeoutMs);
    this.timer.unref?.();
  }

  private carrierEvent(event: CarrierMediaEvent): void {
    if (this.closed || event.type === 'connected') return;
    if (event.type === 'start') {
      if (this.started) throw new Error('duplicate carrier start');
      this.started = true;
      this.buffer = new PreAcceptBuffer(
        event.format,
        this.limits.preAcceptBufferMs,
        this.limits.maxPendingEvents,
      );
      this.identity = { carrierCallId: event.carrierCallId, streamId: event.streamId };
      this.log = this.log.child(this.identity);
      void this.open(event).catch((error: unknown) =>
        this.fail('worker_route_failed', error, 'carrier route failed'),
      );
      return;
    }
    if (!this.started) throw new Error('media received before carrier start');
    if (event.type === 'stop') return this.close(`carrier ${event.reason}`);
    let message: MediaMessage;
    let audioBytes = 0;
    if (event.type === 'audio') {
      audioBytes = event.payload.length;
      if (!audioBytes || audioBytes > this.limits.maxAudioFrameBytes)
        throw new Error('carrier audio frame exceeds limit');
      if (!Number.isSafeInteger(event.seq) || event.seq <= this.lastSequence)
        throw new Error('carrier sequence is duplicate or out of order');
      this.lastSequence = event.seq;
      message = {
        type: 'media.audio',
        payload: Buffer.from(event.payload).toString('base64'),
        sequenceNumber: event.seq,
        timestampMs: event.timestampMs,
      };
    } else if (event.type === 'dtmf') message = { type: 'media.dtmf', digit: event.digit };
    else if (event.type === 'played')
      message = {
        type: 'media.played',
        name: event.name,
        evidence: this.options.accepted.ingress.capabilities.media.playbackEvidence,
      };
    else message = { type: 'media.cleared' };
    if (!this.accepted) {
      if (!this.buffer?.push(message, audioBytes))
        throw new Error('pre-accept media budget exceeded');
    } else this.sendWorker(message);
  }

  private async open(event: Extract<CarrierMediaEvent, { type: 'start' }>): Promise<void> {
    const ingress = this.options.accepted.ingress;
    const selected = await resolveWorkerRoute({
      resolver: this.options.resolver,
      ingress,
      bindingId: this.options.accepted.bindingId,
      authenticatedParams: this.options.accepted.params,
      start: event,
      isClosed: () => this.closed,
    });
    if (!selected) return;
    const { route, sessionId, token } = selected;
    const identity: MediaSessionIdentity = {
      sessionId,
      carrierId: ingress.carrierId,
      bindingId: this.options.accepted.bindingId,
      carrierCallId: event.carrierCallId,
      streamId: event.streamId,
      ownerEpoch: route.ownerEpoch,
      generation: route.generation,
    };
    this.identity = identity;
    this.log = this.log.child({ sessionId, generation: route.generation });
    const events: WorkerLinkEvents = {
      onMessage: (message) => this.workerMessage(message),
      onClose: (reason) => this.close(reason),
    };
    const link = await this.options.dialer.connect(
      route,
      {
        type: 'session.open',
        protocol: 2,
        ...identity,
        format: event.format,
        playbackEvidence: ingress.capabilities.media.playbackEvidence,
        clearFlushesMarkers: ingress.capabilities.media.clearFlushesMarkers,
        routeToken: token,
      },
      events,
      this.connectAbort.signal,
    );
    if (this.closed) return link.close('carrier closed before worker accepted');
    this.link = link;
    for (const message of this.buffer?.drain() ?? []) this.sendWorker(message);
    this.accepted = true;
    this.touch();
    this.options.onStarted?.(identity);
  }

  private sendWorker(message: MediaMessage): void {
    if (!this.link) throw new Error('worker has not accepted carrier session');
    if (this.link.bufferedBytes > this.limits.maxBufferedBytes)
      throw new Error('worker media backpressure limit exceeded');
    this.link.send(message);
  }

  private workerMessage(message: WorkerOutput): void {
    if (this.closed) return;
    this.touch();
    try {
      if (message.type === 'session.end') {
        if (message.reason === 'terminate') {
          this.sendCarrierFrames(this.options.accepted.codec.flush());
          this.sendCarrierFrames(this.options.accepted.codec.terminate?.() ?? []);
        }
        this.close(`worker ended session: ${message.reason}`, false);
        return;
      }
      const command: MediaCommand =
        message.type === 'audio'
          ? { type: 'audio', payload: Buffer.from(message.payload, 'base64') }
          : message.type === 'mark'
            ? { type: 'mark', name: message.name }
            : { type: 'clear' };
      this.sendCarrierFrames(this.options.accepted.codec.encode(command));
    } catch (error) {
      this.fail('carrier_serializer_failed', error, 'carrier serializer failed');
    }
  }

  private sendCarrierFrames(frames: readonly string[]): void {
    for (const frame of frames) {
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error('carrier socket is closed');
      if (this.socket.bufferedAmount > this.limits.maxBufferedBytes)
        throw new Error('carrier media backpressure limit exceeded');
      this.socket.send(frame);
    }
  }

  private fail(event: string, error: unknown, fallback: string): void {
    if (this.closed) return;
    this.log.warn(event, errorFields(error));
    this.close(error instanceof Error ? error.message : fallback);
  }

  /** Called by the gateway at a drain deadline, never when SIGTERM first arrives. */
  close(reason = 'gateway closing', notifyWorker = true): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (!this.link) this.connectAbort.abort();
    if (notifyWorker && this.link) {
      try {
        this.link.send({ type: 'session.close', reason });
      } catch (error) {
        // The worker may already have disconnected; the carrier must still close.
        this.log.warn('worker_close_notify_failed', { reason, ...errorFields(error) });
      }
    }
    this.link?.close(reason);
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.close(1000, Buffer.from(reason).subarray(0, 120).toString());
    else if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
    this.options.onClosed?.(reason, this.identity);
  }
}
