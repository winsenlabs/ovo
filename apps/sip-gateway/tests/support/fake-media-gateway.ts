import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { InboundDecision, StreamGrant } from '@winsendotai/ovo-contracts';
import {
  SipInboundRequestSchema,
  SipMediaFrameInSchema,
  SipResumeRequestSchema,
  SipStatusRequestSchema,
  canonicalUrl,
  createSipRequestVerifier,
  type SipInboundRequest,
  type SipMediaFrameIn,
  type SipStatusRequest,
} from '@winsendotai/ovo-sip-carrier-kit';
import { WebSocketServer, type WebSocket } from 'ws';

export const PUBLIC_BASE = 'https://ovo.example.test';

export interface RecordedFrame {
  at: number;
  dir: 'in' | 'out';
  streamId?: string;
  frame: SipMediaFrameIn | Record<string, unknown>;
}

export interface FakeGatewayOptions {
  key: Uint8Array;
  /** The admission decision for each POST (retry counts from 0). Default: connect. */
  decide?: (request: SipInboundRequest, binding: string) => InboundDecision;
  /** Echo caller audio back after this delay (ms); undefined disables the echo. */
  echoAfterMs?: number;
  /** Append every frame as jsonl here (the SIPp evidence file). */
  jsonlPath?: string;
  /** What `POST resume` answers. Default: a new stream grant. */
  resume?: (callId: string, attempt: number) => StreamGrant | { kind: 'ended' };
}

/**
 * A stand-in for the media gateway that speaks ovo-sip/1 exactly (§5.1–5.3): it verifies every
 * signature with the kit's verifier, answers admission with scripted decisions, records status and
 * resume posts and every media frame, echoes caller audio, and can send marks, clear and terminate
 * or drop the socket on demand.
 */
export class FakeMediaGateway {
  readonly frames: RecordedFrame[] = [];
  readonly inbound: SipInboundRequest[] = [];
  readonly statuses: SipStatusRequest[] = [];
  readonly resumes: string[] = [];
  readonly refusals: string[] = [];
  readonly sockets: WebSocket[] = [];
  private server?: Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly verifier;
  private resumeCount = 0;
  port = 0;

  constructor(private readonly options: FakeGatewayOptions) {
    this.verifier = createSipRequestVerifier({ keys: [options.key] });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The live media socket (the latest one). */
  get socket(): WebSocket | undefined {
    return this.sockets.at(-1);
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      void this.http(req).then(({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    this.server.on('upgrade', (req, socket, head) => {
      void this.verify(req, 'wss', new Uint8Array()).then((ok) => {
        if (!ok) {
          this.refusals.push(`upgrade ${req.url}`);
          socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.media(ws));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : port;
  }

  async stop(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((resolve) => {
      this.server?.closeAllConnections();
      this.server?.close(() => resolve()) ?? resolve();
    });
  }

  private verify(req: IncomingMessage, scheme: 'https' | 'wss', body: Uint8Array) {
    const path = (req.url ?? '/').split('?')[0]!;
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers))
      headers[name] = Array.isArray(value) ? value.join(',') : value;
    return this.verifier.verify({
      method: req.method === 'GET' ? 'GET' : 'POST',
      externalUrl: canonicalUrl(PUBLIC_BASE, path, scheme),
      headers,
      body,
    });
  }

  private async http(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const raw = new Uint8Array(Buffer.concat(chunks));
    if (!(await this.verify(req, 'https', raw))) {
      this.refusals.push(`${req.method} ${req.url}`);
      return { status: 401, body: { error: 'unauthenticated' } };
    }
    const match = /^\/carriers\/([^/]+)\/([^/]+)\/(inbound|status|resume)(?:\?.*)?$/.exec(
      req.url ?? '',
    );
    if (!match) return { status: 404, body: {} };
    const [, carrier, binding, purpose] = match;
    const json: unknown = JSON.parse(Buffer.from(raw).toString('utf8'));
    if (purpose === 'inbound') {
      const parsed = SipInboundRequestSchema.parse(json);
      this.inbound.push(parsed);
      return { status: 200, body: this.decide(parsed, carrier!, binding!) };
    }
    if (purpose === 'status') {
      this.statuses.push(SipStatusRequestSchema.parse(json));
      return { status: 200, body: { result: 'applied' } };
    }
    const resume = SipResumeRequestSchema.parse(json);
    this.resumes.push(resume.callId);
    this.resumeCount += 1;
    return {
      status: 200,
      body:
        this.options.resume?.(resume.callId, this.resumeCount) ??
        this.grant(carrier!, binding!, `rt-${this.resumeCount + 1}`),
    };
  }

  grant(carrier: string, binding: string, rt = 'rt-1'): StreamGrant {
    const base = `${PUBLIC_BASE}/carriers/${carrier}/${binding}`;
    return {
      kind: 'stream',
      mediaUrl: `${base.replace('https:', 'wss:')}/media`,
      routeParams: { sid: 'session-1', rt },
      statusUrl: `${base}/status?r=status-secret`,
      resumeUrl: `${base}/resume?r=resume-secret`,
    };
  }

  private decide(request: SipInboundRequest, carrier: string, binding: string): InboundDecision {
    const decision = this.options.decide?.(request, binding);
    if (decision) return decision;
    const { kind: _kind, ...grant } = this.grant(carrier, binding);
    return { kind: 'connect', ...grant };
  }

  private media(ws: WebSocket): void {
    this.sockets.push(ws);
    let streamId: string | undefined;
    ws.on('message', (data) => {
      const parsed = SipMediaFrameInSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) return void this.refusals.push(`frame ${data.toString().slice(0, 80)}`);
      const frame = parsed.data;
      if (frame.event === 'start') streamId = frame.streamId;
      this.record({ at: Date.now(), dir: 'in', ...(streamId ? { streamId } : {}), frame });
      if (frame.event === 'media' && this.options.echoAfterMs !== undefined)
        setTimeout(
          () => this.send({ event: 'media', payload: frame.payload }, ws),
          this.options.echoAfterMs,
        );
    });
  }

  private record(entry: RecordedFrame): void {
    this.frames.push(entry);
    if (this.options.jsonlPath)
      appendFileSync(this.options.jsonlPath, `${JSON.stringify(entry)}\n`);
  }

  send(frame: Record<string, unknown>, ws = this.socket): void {
    if (!ws || ws.readyState !== ws.OPEN) return;
    this.record({ at: Date.now(), dir: 'out', frame });
    ws.send(JSON.stringify(frame));
  }

  /** Drops the media socket without `terminate` (a gateway restart, as seen by the sip-gateway). */
  drop(): void {
    this.socket?.terminate();
  }

  framesIn(event: string): SipMediaFrameIn[] {
    return this.frames
      .filter((f) => f.dir === 'in' && f.frame.event === event)
      .map((f) => f.frame as SipMediaFrameIn);
  }

  async waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('timed out waiting for the fake media gateway');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
