/** RTP fixed header (RFC 3550 §5.1). */
export interface RtpPacket {
  marker: boolean;
  payloadType: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  payload: Uint8Array;
}

/** Undefined for anything that is not a well-formed RTP version 2 packet. */
export function parseRtp(data: Uint8Array): RtpPacket | undefined {
  if (data.length < 12 || data[0]! >> 6 !== 2) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const padding = (data[0]! & 0x20) !== 0;
  const extension = (data[0]! & 0x10) !== 0;
  const csrcCount = data[0]! & 0x0f;
  let offset = 12 + csrcCount * 4;
  if (extension) {
    if (data.length < offset + 4) return undefined;
    offset += 4 + view.getUint16(offset + 2) * 4;
  }
  let end = data.length;
  if (padding) {
    const pad = data[data.length - 1]!;
    if (pad === 0) return undefined;
    end -= pad;
  }
  if (end < offset) return undefined;
  const payloadType = data[1]! & 0x7f;
  // 72-76 would collide with RTCP packet types (RFC 5761 §4).
  if (payloadType >= 72 && payloadType <= 76) return undefined;
  return {
    marker: (data[1]! & 0x80) !== 0,
    payloadType,
    sequence: view.getUint16(2),
    timestamp: view.getUint32(4),
    ssrc: view.getUint32(8),
    payload: data.subarray(offset, end),
  };
}

export function serializeRtp(packet: RtpPacket): Buffer {
  const out = Buffer.alloc(12 + packet.payload.length);
  out[0] = 0x80;
  out[1] = (packet.marker ? 0x80 : 0) | (packet.payloadType & 0x7f);
  out.writeUInt16BE(packet.sequence & 0xffff, 2);
  out.writeUInt32BE(packet.timestamp >>> 0, 4);
  out.writeUInt32BE(packet.ssrc >>> 0, 8);
  out.set(packet.payload, 12);
  return out;
}

/** RTCP shares the version bits; its packet types are 200-204. */
export function isRtcp(data: Uint8Array): boolean {
  return data.length >= 8 && data[0]! >> 6 === 2 && data[1]! >= 200 && data[1]! <= 204;
}
