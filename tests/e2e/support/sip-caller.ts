import { spawn } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pcm16ToMulaw } from '../../../packages/audio/src/index.ts';
import { speechLikePcm16 } from '../../../packages/conformance/src/drivers/audio-gen.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mu-law.
const RTP_HEADER_BYTES = 12;
const PCMU = 0;
const SPEECH = pcm16ToMulaw(speechLikePcm16({ seed: 11, ms: 2_000, rate: 8_000 }));
const SILENCE = new Uint8Array(FRAME_BYTES).fill(0xff);

/**
 * The caller's RTP leg. SIPp does the signalling only: its SDP offers this socket's port, so the
 * test both speaks (2 s of speech-like mu-law, then silence, one packet every 20 ms) and hears the
 * agent (every RTP payload the sip-gateway sends back, which must be PCMU).
 */
export class RtpCaller {
  readonly socket: Socket = createSocket('udp4');
  agentAudioBytes = 0;
  readonly payloadTypes = new Set<number>();
  private timer?: NodeJS.Timeout;
  private speaking = true;
  private sequence = 1;
  private timestamp = 0;
  private readonly ssrc = 0x0a1b2c3d;

  async bind(): Promise<number> {
    this.socket.bind(0, '127.0.0.1');
    await once(this.socket, 'listening');
    this.socket.on('message', (packet) => {
      if (packet.byteLength <= RTP_HEADER_BYTES || packet[0]! >> 6 !== 2) return;
      this.payloadTypes.add(packet[1]! & 0x7f);
      this.agentAudioBytes += packet.byteLength - RTP_HEADER_BYTES;
    });
    return this.socket.address().port;
  }

  /** Starts sending caller audio to the port the sip-gateway answered with. */
  speakTo(port: number): void {
    let chunk = 0;
    this.timer = setInterval(() => {
      const offset = (chunk * FRAME_BYTES) % SPEECH.byteLength;
      const payload = this.speaking ? SPEECH.subarray(offset, offset + FRAME_BYTES) : SILENCE;
      chunk += 1;
      const header = Buffer.alloc(RTP_HEADER_BYTES);
      header[0] = 0x80;
      header[1] = (chunk === 1 ? 0x80 : 0) | PCMU;
      header.writeUInt16BE(this.sequence++ & 0xffff, 2);
      header.writeUInt32BE(this.timestamp >>> 0, 4);
      header.writeUInt32BE(this.ssrc, 8);
      this.timestamp += FRAME_BYTES;
      this.socket.send(Buffer.concat([header, payload]), port, '127.0.0.1');
    }, 20);
  }

  /** The caller stops talking; RTP keeps flowing with silence, as a phone does. */
  fallSilent(): void {
    this.speaking = false;
  }

  close(): void {
    clearInterval(this.timer);
    this.socket.close();
  }
}

/**
 * One UAC call: INVITE (PCMU + telephone-event, our RTP port) → 100/180 → 200 → ACK, hold for
 * `holdMs`, then the caller's BYE → 200. Any unexpected message (for example a BYE from the
 * sip-gateway because the agent hung up) fails the SIPp run. On the 200 the scenario writes the
 * answered RTP port and the Call-ID to `answerFile` for the test's RTP leg.
 */
export function uacScenario(input: { rtpPort: number; holdMs: number; answerFile: string }) {
  return `<?xml version="1.0" encoding="ISO-8859-1" ?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<scenario name="OVO sip-path UAC">
  <send retrans="500">
    <![CDATA[

      INVITE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch];rport
      From: "OVO e2e" <sip:+919812345678@[local_ip]:[local_port]>;tag=[pid]SIPpTag00[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: <sip:+919812345678@[local_ip]:[local_port];transport=[transport]>
      Max-Forwards: 70
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=- 1 1 IN IP4 [local_ip]
      s=-
      c=IN IP4 [local_ip]
      t=0 0
      m=audio ${input.rtpPort} RTP/AVP 0 101
      a=rtpmap:0 PCMU/8000
      a=rtpmap:101 telephone-event/8000
      a=fmtp:101 0-15
      a=ptime:20
      a=sendrecv

    ]]>
  </send>

  <recv response="100" optional="true"/>
  <recv response="180" optional="true"/>
  <recv response="183" optional="true"/>
  <recv response="200" rtd="true" rrs="true">
    <action>
      <ereg regexp="m=audio ([0-9]+) RTP/AVP 0" search_in="body" check_it="true" assign_to="mline,rtpport"/>
      <exec command="printf '%s %s' '[$rtpport]' '[call_id]' > ${input.answerFile}"/>
    </action>
  </recv>

  <send>
    <![CDATA[

      ACK [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch];rport
      [routes]
      From: "OVO e2e" <sip:+919812345678@[local_ip]:[local_port]>;tag=[pid]SIPpTag00[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 1 ACK
      Contact: <sip:+919812345678@[local_ip]:[local_port];transport=[transport]>
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>

  <pause milliseconds="${input.holdMs}"/>

  <send retrans="500">
    <![CDATA[

      BYE [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch];rport
      [routes]
      From: "OVO e2e" <sip:+919812345678@[local_ip]:[local_port]>;tag=[pid]SIPpTag00[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 2 BYE
      Contact: <sip:+919812345678@[local_ip]:[local_port];transport=[transport]>
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>

  <recv response="200" crlf="true"/>

  <Reference variables="mline"/>
</scenario>
`;
}

export interface SippRun {
  /** Resolves with SIPp's exit code (0: the call completed as scripted). */
  exit: Promise<{ code: number | null; output: string }>;
  /** Resolves once the 200 arrived: the sip-gateway's RTP port and the SIP Call-ID. */
  answered(): Promise<{ rtpPort: number; callId: string }>;
}

/** Runs one SIPp UAC call against the sip-gateway on loopback (OVO_TEST_SIPP is the binary). */
export async function runSippCall(input: {
  sipp: string;
  dir: string;
  target: string;
  service: string;
  localPort: number;
  rtpPort: number;
  holdMs: number;
}): Promise<SippRun> {
  const scenario = join(input.dir, 'uac-call.xml');
  const answerFile = join(input.dir, 'answered.txt');
  await writeFile(scenario, uacScenario({ ...input, answerFile }));
  const child = spawn(
    input.sipp,
    [
      input.target,
      '-sf',
      scenario,
      '-s',
      input.service,
      '-i',
      '127.0.0.1',
      '-p',
      String(input.localPort),
      '-t',
      'u1',
      '-m',
      '1',
      '-nostdin',
      '-timeout',
      `${Math.ceil(input.holdMs / 1000) + 60}s`,
      '-timeout_error',
      '-trace_err',
      '-error_file',
      join(input.dir, 'errors.log'),
    ],
    { cwd: input.dir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (data) => (output += String(data)));
  child.stderr.on('data', (data) => (output += String(data)));
  const exit = new Promise<{ code: number | null; output: string }>((resolve) =>
    child.on('exit', (code) => resolve({ code, output })),
  );
  return {
    exit,
    async answered() {
      for (;;) {
        const text = await readFile(answerFile, 'utf8').catch(() => '');
        const [port, callId] = text.trim().split(' ');
        if (port && callId) return { rtpPort: Number(port), callId };
        const done = await Promise.race([
          exit.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 50)),
        ]);
        if (done) {
          const { code, output: log } = await exit;
          const errors = await readFile(join(input.dir, 'errors.log'), 'utf8').catch(() => '');
          throw new Error(`SIPp exited (${code}) before the 200: ${errors || log}`);
        }
      }
    },
  };
}
