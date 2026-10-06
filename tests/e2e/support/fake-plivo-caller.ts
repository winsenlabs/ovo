import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pcm16ToMulaw } from '../../../packages/audio/src/index.ts';
import { speechLikePcm16 } from '../../../packages/conformance/src/drivers/audio-gen.ts';
import { signV3 } from '../../../packages/plugin-carrier-plivo/src/signature.ts';
import { WebSocket } from '../../../packages/plugin-media/src/index.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mu-law.
const SPEECH = pcm16ToMulaw(speechLikePcm16({ seed: 11, ms: 2_000, rate: 8_000 }));
const unescape = (value: string) =>
  value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');

/**
 * One inbound call on a Plivo number, driven the way Plivo drives it: a V3-signed answer webhook,
 * the returned XML's bidirectional <Stream>, a V3-signed WebSocket upgrade, `start` with the
 * stream's extraHeaders and real-time mu-law media, `playedStream` for each checkpoint, then
 * `stop` and a signed hangup callback. Numbers arrive without the `+`, as Plivo callback examples
 * show them.
 */
export class FakePlivoCall {
  readonly callUuid = randomUUID();
  readonly streamId = randomUUID();
  readonly received: { event: string; media?: { payload: string }; name?: string }[] = [];
  agentAudioBytes = 0;
  /** When each `playAudio` frame arrived (ms since the epoch). */
  readonly audioAt: number[] = [];
  private socket?: WebSocket;
  private sequence = 0;
  private timer?: NodeJS.Timeout;
  private speaking = true;

  constructor(
    private readonly gateway: { origin: string; publicBaseUrl: string },
    private readonly account: { authId: string; authToken: string },
    private readonly numbers: { from: string; to: string },
  ) {}

  private async signed(url: string, params: Record<string, string> = {}) {
    const nonce = randomBytes(10).toString('hex');
    return {
      'x-plivo-signature-v3': await signV3(this.account.authToken, url, nonce, params),
      'x-plivo-signature-v3-nonce': nonce,
    };
  }

  private async post(publicUrl: string, params: Record<string, string>) {
    const url = new URL(publicUrl);
    if (url.origin !== this.gateway.publicBaseUrl) throw new Error(`unexpected URL ${publicUrl}`);
    return fetch(`${this.gateway.origin}${url.pathname}${url.search}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(await this.signed(publicUrl, params)),
      },
      body: new URLSearchParams(params),
    });
  }

  private callParams(status: string): Record<string, string> {
    return {
      CallUUID: this.callUuid,
      CallStatus: status,
      Direction: 'inbound',
      Event: status === 'ringing' ? 'StartApp' : 'Hangup',
      From: this.numbers.from.replace(/^\+/, ''),
      To: this.numbers.to.replace(/^\+/, ''),
    };
  }

  /** The answer URL; returns the XML Plivo would execute. */
  async ring(answerUrl: string): Promise<{ status: number; xml: string }> {
    const response = await this.post(answerUrl, this.callParams('ringing'));
    return { status: response.status, xml: await response.text() };
  }

  /** Opens the <Stream> from the XML, reports it started, and starts sending caller audio. */
  async connect(xml: string): Promise<{ streamStatus: number }> {
    const stream = /<Stream ([^>]*)>([^<]+)<\/Stream>/.exec(xml);
    if (!stream) throw new Error(`Plivo XML has no <Stream>: ${xml}`);
    const attribute = (name: string) =>
      unescape(new RegExp(`${name}="([^"]*)"`).exec(stream[1]!)?.[1] ?? '');
    const url = new URL(unescape(stream[2]!));
    const socket = new WebSocket(`${this.gateway.origin.replace(/^http/, 'ws')}${url.pathname}`, {
      headers: await this.signed(url.href),
    });
    this.socket = socket;
    socket.on('message', (raw) => this.onMessage(String(raw)));
    await once(socket, 'open');
    this.send({
      event: 'start',
      start: {
        callId: this.callUuid,
        streamId: this.streamId,
        accountId: this.account.authId,
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 },
      },
      extra_headers: attribute('extraHeaders'),
    });
    const statusUrl = attribute('statusCallbackUrl');
    const streamStatus = statusUrl
      ? (
          await this.post(statusUrl, {
            CallUUID: this.callUuid,
            StreamID: this.streamId,
            Event: 'started',
          })
        ).status
      : 0;
    let chunk = 0;
    this.timer = setInterval(() => {
      const offset = (chunk * FRAME_BYTES) % SPEECH.byteLength;
      const frame = this.speaking
        ? SPEECH.subarray(offset, offset + FRAME_BYTES)
        : new Uint8Array(FRAME_BYTES).fill(0xff);
      chunk += 1;
      this.send({
        event: 'media',
        media: {
          track: 'inbound',
          timestamp: String(chunk * 20),
          chunk,
          payload: Buffer.from(frame).toString('base64'),
        },
      });
    }, 20);
    return { streamStatus };
  }

  /** The caller stops talking; Plivo keeps streaming silence. */
  fallSilent(): number {
    this.speaking = false;
    return Date.now();
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Caller hangs up: `stop` on the stream, the socket closes, then the hangup callback. */
  async hangUp(hangupUrl: string): Promise<number> {
    clearInterval(this.timer);
    if (this.connected) {
      this.send({ event: 'stop' });
      this.socket!.close(1000);
    }
    const response = await this.post(hangupUrl, {
      ...this.callParams('completed'),
      Duration: '12',
      BillDuration: '60',
      HangupCauseName: 'Normal Hangup',
    });
    return response.status;
  }

  close(): void {
    clearInterval(this.timer);
    this.socket?.terminate();
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.connected) return;
    const sequenced =
      frame.event === 'start'
        ? { sequenceNumber: ++this.sequence, ...frame }
        : { sequenceNumber: ++this.sequence, streamId: this.streamId, ...frame };
    this.socket!.send(JSON.stringify(sequenced));
  }

  private onMessage(raw: string): void {
    const message = JSON.parse(raw) as FakePlivoCall['received'][number];
    this.received.push(message);
    if (message.event === 'playAudio' && message.media) {
      this.audioAt.push(Date.now());
      this.agentAudioBytes += Buffer.from(message.media.payload, 'base64').byteLength;
    }
    // Plivo reports a checkpoint once the audio queued before it has played.
    if (message.event === 'checkpoint' && message.name)
      this.send({ event: 'playedStream', name: message.name });
  }
}
