import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { pcm16ToMulaw } from '../../../packages/audio/src/index.ts';
import { speechLikePcm16 } from '../../../packages/conformance/src/drivers/audio-gen.ts';
import { WebSocket } from '../../../packages/plugin-media/src/index.ts';

/** Twilio's documented webhook signature, computed independently of the product's validator. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const payload = Object.keys(params)
    .sort()
    .reduce((text, key) => text + key + params[key], url);
  return createHmac('sha1', authToken).update(payload).digest('base64');
}

const sid = (prefix: string) => prefix + randomBytes(16).toString('hex');
const FRAME_BYTES = 160; // 20 ms of 8 kHz mu-law, Twilio's media frame size.
const SPEECH = pcm16ToMulaw(speechLikePcm16({ seed: 7, ms: 2_000, rate: 8_000 }));

/**
 * One Twilio inbound call, driven the way Twilio drives it: a signed Voice webhook to the public
 * URL, the returned TwiML's <Stream>, a signed WebSocket upgrade, `start` and real-time mu-law
 * media, mark echoes, then `stop` and a signed `completed` status callback.
 */
export class FakeTwilioCall {
  readonly callSid = sid('CA');
  readonly streamSid = sid('MZ');
  readonly received: { event: string; media?: { payload: string }; mark?: { name: string } }[] = [];
  agentAudioBytes = 0;
  private socket?: WebSocket;
  private sequence = 0;
  private timer?: NodeJS.Timeout;
  private speaking = true;

  constructor(
    private readonly gateway: { origin: string; publicBaseUrl: string },
    private readonly account: { accountSid: string; authToken: string },
    private readonly numbers: { from: string; to: string },
  ) {}

  private async post(publicUrl: string, params: Record<string, string>) {
    const url = new URL(publicUrl);
    if (url.origin !== this.gateway.publicBaseUrl) throw new Error(`unexpected URL ${publicUrl}`);
    return fetch(`${this.gateway.origin}${url.pathname}${url.search}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilioSignature(this.account.authToken, publicUrl, params),
      },
      body: new URLSearchParams(params),
    });
  }

  private callParams(status: string): Record<string, string> {
    return {
      AccountSid: this.account.accountSid,
      ApiVersion: '2010-04-01',
      CallSid: this.callSid,
      CallStatus: status,
      Direction: 'inbound',
      From: this.numbers.from,
      To: this.numbers.to,
    };
  }

  /** The Voice webhook; returns the TwiML Twilio would execute. */
  async ring(voiceUrl: string): Promise<{ status: number; twiml: string }> {
    const response = await this.post(voiceUrl, this.callParams('ringing'));
    return { status: response.status, twiml: await response.text() };
  }

  /** Opens the <Stream> from the TwiML and starts sending caller audio in real time. */
  async connect(twiml: string): Promise<void> {
    const streamUrl = /<Stream url="([^"]+)"/.exec(twiml)?.[1];
    if (!streamUrl) throw new Error(`TwiML has no <Stream>: ${twiml}`);
    const customParameters = Object.fromEntries(
      [...twiml.matchAll(/<Parameter name="([^"]+)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    const url = new URL(streamUrl.replaceAll('&amp;', '&'));
    const socket = new WebSocket(`${this.gateway.origin.replace(/^http/, 'ws')}${url.pathname}`, {
      headers: { 'x-twilio-signature': twilioSignature(this.account.authToken, url.href, {}) },
    });
    this.socket = socket;
    socket.on('message', (raw) => this.onMessage(String(raw)));
    await once(socket, 'open');
    this.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    this.send({
      event: 'start',
      start: {
        streamSid: this.streamSid,
        accountSid: this.account.accountSid,
        callSid: this.callSid,
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        customParameters,
      },
    });
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
          chunk: String(chunk),
          timestamp: String(chunk * 20),
          payload: Buffer.from(frame).toString('base64'),
        },
      });
    }, 20);
  }

  /** The caller stops talking; Twilio keeps streaming silence. */
  fallSilent(): void {
    this.speaking = false;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Caller hangs up: Twilio sends `stop`, closes the stream, then posts the final status. */
  async hangUp(statusUrl: string): Promise<number> {
    clearInterval(this.timer);
    if (this.connected) {
      this.send({
        event: 'stop',
        stop: { accountSid: this.account.accountSid, callSid: this.callSid },
      });
      this.socket!.close(1000);
    }
    const response = await this.post(statusUrl, {
      ...this.callParams('completed'),
      CallDuration: '12',
      SequenceNumber: '3',
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
      frame.event === 'connected'
        ? frame
        : { sequenceNumber: String(++this.sequence), streamSid: this.streamSid, ...frame };
    this.socket!.send(JSON.stringify(sequenced));
  }

  private onMessage(raw: string): void {
    const message = JSON.parse(raw) as FakeTwilioCall['received'][number];
    this.received.push(message);
    if (message.event === 'media' && message.media)
      this.agentAudioBytes += Buffer.from(message.media.payload, 'base64').byteLength;
    // Twilio echoes a mark once the audio queued before it has played.
    if (message.event === 'mark' && message.mark)
      this.send({ event: 'mark', mark: { name: message.mark.name } });
  }
}
