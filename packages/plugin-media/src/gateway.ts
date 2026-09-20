import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  parseTwilioMediaMessage,
  twilioClear,
  twilioMark,
  twilioMedia,
  validateTwilioSignature,
} from '@winsendotai/ovo-plugin-telephony-twilio';
import type {
  GatewayToWorkerMessage,
  MediaRouteResolver,
  CarrierCallbackProjector,
  MediaSessionIdentity,
  WorkerToGatewayMessage,
} from './ports.ts';
import { encodeGatewayMessage, parseWorkerMessage, sameIdentity } from './protocol.ts';
import { acceptWebSocket, type WebSocketPeer } from './websocket-peer.ts';
import { constantEqual, errorMessage, rejectUpgrade } from './gateway-support.ts';
import { createGatewayHttpHandler } from './carrier-callback.ts';
import type { CarrierSession, MediaGatewayConfig, WorkerConnection } from './gateway-types.ts';

export type { MediaGatewayConfig } from './gateway-types.ts';

export class MediaGateway {
  private readonly server: Server;
  private readonly workers = new Map<string, WorkerConnection>();
  private readonly sessions = new Map<string, CarrierSession>();
  private readonly limits: Required<
    Pick<
      MediaGatewayConfig,
      | 'maxMessageBytes'
      | 'maxAudioFrameBytes'
      | 'maxBufferedBytes'
      | 'maxPendingFrames'
      | 'handshakeTimeoutMs'
      | 'idleTimeoutMs'
      | 'drainTimeoutMs'
    >
  >;
  private draining = false;

  constructor(
    private readonly resolver: MediaRouteResolver & Partial<CarrierCallbackProjector>,
    private readonly config: MediaGatewayConfig,
  ) {
    if (!config.publicBaseUrl.startsWith('https://'))
      throw new Error('publicBaseUrl must use HTTPS');
    this.limits = {
      maxMessageBytes: config.maxMessageBytes ?? 64 * 1024,
      maxAudioFrameBytes: config.maxAudioFrameBytes ?? 8 * 1024,
      maxBufferedBytes: config.maxBufferedBytes ?? 256 * 1024,
      maxPendingFrames: config.maxPendingFrames ?? 25,
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? 5_000,
      idleTimeoutMs: config.idleTimeoutMs ?? 30_000,
      drainTimeoutMs: config.drainTimeoutMs ?? 30_000,
    };
    this.server = createServer(
      createGatewayHttpHandler(this.resolver, this.config, () => ({
        draining: this.draining,
        sessions: this.sessions.size,
      })),
    );
    this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
  }

  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port ?? 0, this.config.host ?? '127.0.0.1', () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    return { host: address.address, port: address.port };
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const deadline = Date.now() + this.limits.drainTimeoutMs;
    while (this.sessions.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    for (const session of this.sessions.values())
      this.endSession(session, 'gateway drain deadline');
    for (const worker of this.workers.values()) worker.peer.close(1001, 'gateway drained');
    await this.closeServer();
  }

  async close(): Promise<void> {
    this.draining = true;
    for (const session of this.sessions.values()) this.endSession(session, 'gateway closing');
    for (const worker of this.workers.values()) worker.peer.close(1001, 'gateway closing');
    await this.closeServer();
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void {
    if (this.draining) return rejectUpgrade(socket, 503);
    const pathname = new URL(request.url ?? '/', 'http://internal').pathname;
    if (pathname === '/worker') return this.acceptWorker(request, socket, head);
    if (pathname !== '/twilio/media') return rejectUpgrade(socket, 404);
    const externalUrl = new URL(request.url ?? '/', this.config.publicBaseUrl).toString();
    const signature = request.headers['x-twilio-signature'];
    if (
      !validateTwilioSignature({
        authToken: this.config.twilioAuthToken,
        signature: typeof signature === 'string' ? signature : undefined,
        externalUrl,
      })
    )
      return rejectUpgrade(socket, 401);
    const peer = acceptWebSocket(request, socket, head, {
      maxMessageBytes: this.limits.maxMessageBytes,
      requireMasked: true,
    });
    if (peer) this.acceptCarrier(peer);
  }

  private acceptWorker(
    request: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void {
    const peer = acceptWebSocket(request, socket, head, {
      maxMessageBytes: this.limits.maxMessageBytes,
      requireMasked: true,
    });
    if (!peer) return;
    const connection: WorkerConnection = {
      peer,
      authenticated: false,
      timer: setTimeout(
        () => peer.close(1008, 'worker authentication timeout'),
        this.limits.handshakeTimeoutMs,
      ),
    };
    connection.timer.unref?.();
    peer.onMessage((raw) => void this.onWorkerMessage(connection, raw));
    peer.onClose(() => this.removeWorker(connection));
  }

  private async onWorkerMessage(connection: WorkerConnection, raw: string): Promise<void> {
    try {
      const message = parseWorkerMessage(raw, this.limits.maxAudioFrameBytes);
      if (!connection.authenticated) return this.authenticateWorker(connection, message);
      if (message.type === 'worker.hello') throw new Error('duplicate worker hello');
      const session = this.sessions.get(message.streamSid);
      if (
        !session?.identity ||
        session.worker !== connection ||
        !sameIdentity(session.identity, message)
      )
        throw new Error('worker does not own media session');
      this.touch(session);
      if (message.type === 'session.accept') return this.acceptSession(session);
      if (!session.accepted) throw new Error('media sent before session acceptance');
      this.sendCarrier(session, message);
    } catch (error) {
      connection.peer.close(1008, errorMessage(error));
    }
  }

  private authenticateWorker(connection: WorkerConnection, message: WorkerToGatewayMessage): void {
    if (message.type !== 'worker.hello' || !constantEqual(message.token, this.config.workerToken))
      throw new Error('worker authentication failed');
    if (this.workers.has(message.workerId)) throw new Error('worker already connected');
    clearTimeout(connection.timer);
    connection.workerId = message.workerId;
    connection.authenticated = true;
    this.workers.set(message.workerId, connection);
    connection.peer.send(
      encodeGatewayMessage({ type: 'worker.ready', workerId: message.workerId }),
    );
  }

  private acceptCarrier(peer: WebSocketPeer): void {
    const session: CarrierSession = {
      peer,
      accepted: false,
      pending: [],
      lastSequence: 0,
      timer: setTimeout(
        () => this.endSession(session, 'carrier start timeout'),
        this.limits.handshakeTimeoutMs,
      ),
    };
    session.timer.unref?.();
    peer.onMessage((raw) => void this.onCarrierMessage(session, raw));
    peer.onClose((reason) => this.endSession(session, reason, false));
  }

  private async onCarrierMessage(session: CarrierSession, raw: string): Promise<void> {
    try {
      const event = parseTwilioMediaMessage(raw);
      if ('sequenceNumber' in event) {
        if (event.sequenceNumber <= session.lastSequence)
          throw new Error('carrier sequence is duplicate or out of order');
        session.lastSequence = event.sequenceNumber;
      }
      if (event.type === 'connected' || event.type === 'clear') return;
      if (event.type === 'start')
        return await this.startSession(
          session,
          event.callSid,
          event.streamSid,
          event.customParameters,
        );
      if (!session.identity || event.streamSid !== session.identity.streamSid)
        throw new Error('media received before matching start');
      this.touch(session);
      if (event.type === 'stop') return this.endSession(session, 'carrier stopped', true, 'stop');
      if (event.type === 'media') {
        const bytes = Buffer.from(event.payload, 'base64');
        if (bytes.length === 0 || bytes.length > this.limits.maxAudioFrameBytes)
          throw new Error('carrier audio frame exceeds limit');
      }
      const message: GatewayToWorkerMessage =
        event.type === 'media'
          ? {
              type: 'media.audio',
              ...session.identity,
              payload: event.payload,
              sequenceNumber: event.sequenceNumber,
              timestampMs: event.timestampMs,
            }
          : event.type === 'mark'
            ? { type: 'media.mark', ...session.identity, name: event.name }
            : { type: 'media.dtmf', ...session.identity, digit: event.digit };
      this.forwardWorker(session, message);
    } catch (error) {
      this.endSession(session, errorMessage(error));
    }
  }

  private async startSession(
    session: CarrierSession,
    callSid: string,
    streamSid: string,
    parameters: Record<string, string>,
  ): Promise<void> {
    if (session.identity) throw new Error('duplicate carrier start');
    const sessionId = parameters.sessionId;
    const routeToken = parameters.routeToken;
    if (!sessionId || !routeToken)
      throw new Error('missing authenticated session route parameters');
    const route = await this.resolver.authenticateSessionRoute(sessionId, routeToken);
    const byCall = await this.resolver.resolveSessionRoute({ carrierCallId: callSid });
    if (
      !route ||
      !byCall ||
      route.sessionId !== byCall.sessionId ||
      route.workerId !== byCall.workerId ||
      route.ownerEpoch !== byCall.ownerEpoch ||
      route.generation !== byCall.generation ||
      route.terminalAt
    )
      throw new Error('no valid authenticated durable session route');
    const worker = this.workers.get(route.workerId);
    if (!worker?.authenticated) throw new Error('owning worker is unavailable');
    const identity = {
      sessionId: route.sessionId,
      callSid,
      streamSid,
      ownerId: route.workerId,
      ownerEpoch: route.ownerEpoch,
      generation: route.generation,
    };
    session.route = route;
    session.identity = identity;
    session.worker = worker;
    this.sessions.set(streamSid, session);
    this.forwardWorker(session, {
      type: 'session.open',
      ...identity,
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
    });
  }

  private acceptSession(session: CarrierSession): void {
    session.accepted = true;
    this.touch(session);
    for (const message of session.pending.splice(0)) this.forwardWorker(session, message);
  }

  private forwardWorker(session: CarrierSession, message: GatewayToWorkerMessage): void {
    const worker = session.worker;
    if (!worker || worker.peer.bufferedBytes > this.limits.maxBufferedBytes)
      return this.endSession(session, 'worker backpressure limit exceeded');
    if (!session.accepted && message.type !== 'session.open') {
      if (session.pending.length >= this.limits.maxPendingFrames)
        return this.endSession(session, 'pre-accept media buffer exceeded');
      session.pending.push(message);
      return;
    }
    worker.peer.send(encodeGatewayMessage(message));
  }

  private sendCarrier(
    session: CarrierSession,
    message: Exclude<WorkerToGatewayMessage, { type: 'worker.hello' }>,
  ): void {
    if (session.peer.bufferedBytes > this.limits.maxBufferedBytes)
      return this.endSession(session, 'carrier backpressure limit exceeded');
    if (message.type === 'media.audio')
      session.peer.send(twilioMedia(message.streamSid, message.payload));
    else if (message.type === 'media.mark')
      session.peer.send(twilioMark(message.streamSid, message.name));
    else if (message.type === 'media.clear') session.peer.send(twilioClear(message.streamSid));
    else if (message.type === 'session.close') this.endSession(session, message.reason);
  }

  private touch(session: CarrierSession): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(
      () => this.endSession(session, 'media idle deadline exceeded'),
      this.limits.idleTimeoutMs,
    );
    session.timer.unref?.();
  }

  private endSession(
    session: CarrierSession,
    reason: string,
    closeCarrier = true,
    notification: 'cancel' | 'stop' = 'cancel',
  ): void {
    clearTimeout(session.timer);
    if (session.identity) {
      this.sessions.delete(session.identity.streamSid);
      if (session.worker?.authenticated)
        session.worker.peer.send(
          JSON.stringify({
            type: notification === 'stop' ? 'session.stop' : 'session.cancel',
            ...session.identity,
            reason,
          }),
        );
    }
    if (closeCarrier) session.peer.close(notification === 'stop' ? 1000 : 1011, reason);
  }

  private removeWorker(connection: WorkerConnection): void {
    clearTimeout(connection.timer);
    if (connection.workerId && this.workers.get(connection.workerId) === connection)
      this.workers.delete(connection.workerId);
    for (const session of this.sessions.values())
      if (session.worker === connection) this.endSession(session, 'owning worker disconnected');
  }

  private async closeServer(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
