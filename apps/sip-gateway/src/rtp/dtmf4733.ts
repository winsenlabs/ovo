/** RFC 4733 telephone-events: events 0-15 are `0-9 * # A-D` (§3.2). */
export const DTMF_EVENTS = '0123456789*#ABCD';

export interface DtmfEvent {
  digit: string;
  durationMs: number;
}

export interface TelephoneEvent {
  event: number;
  end: boolean;
  volume: number;
  /** In timestamp units. */
  duration: number;
}

export function parseTelephoneEvent(payload: Uint8Array): TelephoneEvent | undefined {
  if (payload.length < 4) return undefined;
  return {
    event: payload[0]!,
    end: (payload[1]! & 0x80) !== 0,
    volume: payload[1]! & 0x3f,
    duration: (payload[2]! << 8) | payload[3]!,
  };
}

export function encodeTelephoneEvent(event: TelephoneEvent): Uint8Array {
  return Uint8Array.of(
    event.event,
    (event.end ? 0x80 : 0) | (event.volume & 0x3f),
    (event.duration >> 8) & 0xff,
    event.duration & 0xff,
  );
}

/**
 * Emits one DTMF per event: on the first end packet for an event timestamp; the redundant end
 * retransmissions (and any later update for that timestamp) are deduplicated.
 */
export class DtmfReceiver {
  private readonly done: number[] = [];

  receive(timestamp: number, payload: Uint8Array): DtmfEvent | undefined {
    const event = parseTelephoneEvent(payload);
    if (!event || !event.end || event.event >= DTMF_EVENTS.length) return undefined;
    if (this.done.includes(timestamp)) return undefined;
    this.done.push(timestamp);
    if (this.done.length > 16) this.done.shift();
    return { digit: DTMF_EVENTS[event.event]!, durationMs: Math.round(event.duration / 8) };
  }
}

/**
 * The packets for one digit (§2.5): the same timestamp throughout, M bit on the first, a 50 ms
 * update cadence, then three end packets.
 */
export function dtmfPackets(
  digit: string,
  durationMs: number,
): { marker: boolean; payload: Uint8Array }[] {
  const event = DTMF_EVENTS.indexOf(digit.toUpperCase());
  if (event < 0 || digit.length !== 1) throw new RangeError(`not a DTMF digit: ${digit}`);
  const total = Math.max(1, Math.round(durationMs * 8));
  const packets: { marker: boolean; payload: Uint8Array }[] = [];
  for (let duration = 400; duration < total; duration += 400)
    packets.push({
      marker: packets.length === 0,
      payload: encodeTelephoneEvent({ event, end: false, volume: 10, duration }),
    });
  for (let i = 0; i < 3; i += 1)
    packets.push({
      marker: packets.length === 0,
      payload: encodeTelephoneEvent({ event, end: true, volume: 10, duration: total }),
    });
  return packets;
}
