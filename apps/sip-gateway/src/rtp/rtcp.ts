/** RTCP SR/RR + SDES CNAME compound packets and BYE (RFC 3550 §6). No rtcp-mux. */

export interface SenderInfo {
  ssrc: number;
  packets: number;
  octets: number;
  rtpTimestamp: number;
}

export interface ReportBlock {
  ssrc: number;
  /** Cumulative counters; the reporter derives the per-interval fraction. */
  expected: number;
  received: number;
  highestSequence: number;
  jitter: number;
}

export interface PeerReport {
  fractionLost: number;
  cumulativeLost: number;
  jitter: number;
}

const NTP_EPOCH_OFFSET = 2_208_988_800;

function header(count: number, type: number, words: number): Buffer {
  const out = Buffer.alloc(4);
  out[0] = 0x80 | (count & 0x1f);
  out[1] = type;
  out.writeUInt16BE(words - 1, 2);
  return out;
}

function sdes(ssrc: number, cname: string): Buffer {
  const text = Buffer.from(cname.slice(0, 255), 'utf8');
  const chunk = 4 + 2 + text.length + 1;
  const padded = Math.ceil(chunk / 4) * 4;
  const body = Buffer.alloc(padded);
  body.writeUInt32BE(ssrc >>> 0, 0);
  body[4] = 1;
  body[5] = text.length;
  text.copy(body, 6);
  return Buffer.concat([header(1, 202, 1 + padded / 4), body]);
}

export class RtcpReporter {
  private prior = { expected: 0, received: 0 };
  private lastSr?: { middle: number; at: number };

  constructor(
    private readonly ssrc: number,
    private readonly cname: string,
  ) {}

  /** Remembers the peer's last SR so our report can carry LSR/DLSR. */
  observe(data: Uint8Array, nowMs: number): PeerReport | undefined {
    let offset = 0;
    let report: PeerReport | undefined;
    const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    while (offset + 8 <= view.length) {
      const count = view[offset]! & 0x1f;
      const type = view[offset + 1]!;
      const length = (view.readUInt16BE(offset + 2) + 1) * 4;
      if (offset + length > view.length) break;
      let blocks = offset + 8;
      if (type === 200 && length >= 28) {
        this.lastSr = { middle: view.readUInt32BE(offset + 10), at: nowMs };
        blocks = offset + 28;
      }
      if ((type === 200 || type === 201) && count > 0 && blocks + 24 <= offset + length)
        report = {
          fractionLost: view[blocks + 4]! / 256,
          cumulativeLost: view.readUIntBE(blocks + 5, 3),
          jitter: view.readUInt32BE(blocks + 12),
        };
      offset += length;
    }
    return report;
  }

  /** SR when we have sent media, else RR; always followed by SDES CNAME. */
  build(nowMs: number, sender: SenderInfo | undefined, block: ReportBlock | undefined): Buffer {
    const blocks: Buffer[] = [];
    if (block) {
      const expected = block.expected - this.prior.expected;
      const received = block.received - this.prior.received;
      const lost = expected - received;
      this.prior = { expected: block.expected, received: block.received };
      const out = Buffer.alloc(24);
      out.writeUInt32BE(block.ssrc >>> 0, 0);
      out[4] = expected > 0 && lost > 0 ? Math.min(255, Math.floor((lost * 256) / expected)) : 0;
      out.writeUIntBE(Math.max(0, Math.min(0x7fffff, block.expected - block.received)), 5, 3);
      out.writeUInt32BE(block.highestSequence >>> 0, 8);
      out.writeUInt32BE(block.jitter >>> 0, 12);
      if (this.lastSr) {
        out.writeUInt32BE(this.lastSr.middle >>> 0, 16);
        out.writeUInt32BE(Math.round(((nowMs - this.lastSr.at) / 1000) * 65536) >>> 0, 20);
      }
      blocks.push(out);
    }
    const reports = Buffer.concat(blocks);
    let first: Buffer;
    if (sender) {
      const info = Buffer.alloc(24);
      info.writeUInt32BE(this.ssrc >>> 0, 0);
      const seconds = nowMs / 1000 + NTP_EPOCH_OFFSET;
      info.writeUInt32BE(Math.floor(seconds) >>> 0, 4);
      info.writeUInt32BE(Math.floor((seconds % 1) * 2 ** 32) >>> 0, 8);
      info.writeUInt32BE(sender.rtpTimestamp >>> 0, 12);
      info.writeUInt32BE(sender.packets >>> 0, 16);
      info.writeUInt32BE(sender.octets >>> 0, 20);
      first = Buffer.concat([
        header(blocks.length, 200, 1 + (24 + reports.length) / 4),
        info,
        reports,
      ]);
    } else {
      const ssrc = Buffer.alloc(4);
      ssrc.writeUInt32BE(this.ssrc >>> 0);
      first = Buffer.concat([
        header(blocks.length, 201, 1 + (4 + reports.length) / 4),
        ssrc,
        reports,
      ]);
    }
    return Buffer.concat([first, sdes(this.ssrc, this.cname)]);
  }

  /** RR + SDES + BYE, sent on teardown. */
  bye(nowMs: number, sender: SenderInfo | undefined, block: ReportBlock | undefined): Buffer {
    const bye = Buffer.alloc(8);
    bye[0] = 0x81;
    bye[1] = 203;
    bye.writeUInt16BE(1, 2);
    bye.writeUInt32BE(this.ssrc >>> 0, 4);
    return Buffer.concat([this.build(nowMs, sender, block), bye]);
  }
}
