/** Per-source RTP receive state: RFC 3550 Appendix A.1 (sequence) and A.8 (jitter). */
const MIN_SEQUENTIAL = 2;
const MAX_DROPOUT = 3000;
const MAX_MISORDER = 100;
const SEQ_MOD = 65536;

export interface ReceiveStats {
  packets: number;
  expected: number;
  lost: number;
  lossPct: number;
  jitterMs: number;
}

export class RtpSource {
  private maxSeq: number;
  private cycles = 0;
  private baseSeq: number;
  private badSeq = SEQ_MOD + 1;
  private probation = MIN_SEQUENTIAL;
  private received = 0;
  private transit?: number;
  private jitter = 0;
  private lastTs?: number;
  private tsCycles = 0;

  constructor(
    readonly ssrc: number,
    sequence: number,
    private readonly clockRate = 8000,
  ) {
    this.baseSeq = sequence;
    this.maxSeq = (sequence - 1) & 0xffff;
  }

  private reset(sequence: number) {
    this.baseSeq = sequence;
    this.maxSeq = sequence;
    this.badSeq = SEQ_MOD + 1;
    this.cycles = 0;
    this.received = 0;
  }

  /** A.1 `update_seq`; false while on probation or for a wild jump. */
  update(sequence: number): boolean {
    const delta = (sequence - this.maxSeq) & 0xffff;
    if (this.probation) {
      if (sequence === ((this.maxSeq + 1) & 0xffff)) {
        this.probation -= 1;
        this.maxSeq = sequence;
        if (this.probation === 0) {
          this.reset(sequence);
          this.received += 1;
          return true;
        }
      } else {
        this.probation = MIN_SEQUENTIAL - 1;
        this.maxSeq = sequence;
      }
      return false;
    }
    if (delta < MAX_DROPOUT) {
      if (sequence < this.maxSeq) this.cycles += SEQ_MOD;
      this.maxSeq = sequence;
    } else if (delta <= SEQ_MOD - MAX_MISORDER) {
      if (sequence !== this.badSeq) {
        this.badSeq = (sequence + 1) & 0xffff;
        return false;
      }
      // Two sequential packets after a jump: the source restarted.
      this.reset(sequence);
    }
    this.received += 1;
    return true;
  }

  /** The 32-bit extended sequence of a packet just accepted by `update`. */
  extendedSequence(sequence: number): number {
    let extended = this.cycles + sequence;
    if (sequence > this.maxSeq && sequence - this.maxSeq > SEQ_MOD / 2) extended -= SEQ_MOD;
    return extended;
  }

  /** Unwraps the 32-bit RTP timestamp into a monotonic sample position. */
  extendedTimestamp(timestamp: number): number {
    if (this.lastTs !== undefined) {
      const diff = timestamp - this.lastTs;
      if (diff < -0x80000000) this.tsCycles += 0x100000000;
      else if (diff > 0x80000000) return this.tsCycles - 0x100000000 + timestamp;
    }
    this.lastTs = timestamp;
    return this.tsCycles + timestamp;
  }

  /** A.8: J += (|D| − J) / 16, in timestamp units, from arrival time in ms. */
  arrival(arrivalMs: number, timestamp: number): void {
    const transit = (arrivalMs * this.clockRate) / 1000 - timestamp;
    if (this.transit !== undefined) {
      const d = Math.abs(transit - this.transit);
      this.jitter += (d - this.jitter) / 16;
    }
    this.transit = transit;
  }

  get jitterMs(): number {
    return (this.jitter * 1000) / this.clockRate;
  }

  get highestSequence(): number {
    return this.cycles + this.maxSeq;
  }

  get jitterUnits(): number {
    return Math.round(this.jitter);
  }

  stats(): ReceiveStats {
    const expected = Math.max(0, this.highestSequence - this.baseSeq + 1);
    const lost = Math.max(0, expected - this.received);
    return {
      packets: this.received,
      expected,
      lost,
      lossPct: expected ? Math.round((lost / expected) * 1000) / 10 : 0,
      jitterMs: Math.round(this.jitterMs * 10) / 10,
    };
  }
}
