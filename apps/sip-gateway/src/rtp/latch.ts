/** Where RTP goes, and from where RTP is believed (§4.4, the RTP Bleed mitigation). */
export interface Endpoint {
  address: string;
  port: number;
}

const same = (a: Endpoint, b: Endpoint) => a.address === b.address && a.port === b.port;

/**
 * The destination starts as the SDP `c=`/`m=` address. Media is accepted only from the signalled
 * address or the trunk's media CIDRs; a different port (NAT, SBC) becomes the destination after
 * two in-sequence packets with a negotiated payload type and one SSRC.
 */
export class MediaLatch {
  private candidate?: { from: Endpoint; ssrc: number; sequence: number; count: number };
  private target: Endpoint;
  latches = 0;
  ignored = 0;

  constructor(
    private signalled: Endpoint,
    private readonly allowed: (address: string) => boolean,
  ) {
    this.target = signalled;
  }

  get destination(): Endpoint {
    return this.target;
  }

  /** A re-INVITE moved the media: start again from the new signalled address. */
  resignal(endpoint: Endpoint): void {
    this.signalled = endpoint;
    this.target = endpoint;
    this.candidate = undefined;
  }

  /** Whether a packet from `from` may be used; may move the destination. */
  accept(
    from: Endpoint,
    packet: { ssrc: number; sequence: number },
    negotiatedType: boolean,
  ): boolean {
    if (from.address !== this.signalled.address && !this.allowed(from.address)) {
      this.ignored += 1;
      return false;
    }
    if (same(from, this.target)) {
      this.candidate = undefined;
      return true;
    }
    if (!negotiatedType) return true;
    const c = this.candidate;
    if (
      c &&
      same(c.from, from) &&
      c.ssrc === packet.ssrc &&
      ((c.sequence + 1) & 0xffff) === packet.sequence
    ) {
      c.count += 1;
      c.sequence = packet.sequence;
      if (c.count >= 2) {
        this.target = from;
        this.candidate = undefined;
        this.latches += 1;
      }
    } else this.candidate = { from, ssrc: packet.ssrc, sequence: packet.sequence, count: 1 };
    return true;
  }
}
