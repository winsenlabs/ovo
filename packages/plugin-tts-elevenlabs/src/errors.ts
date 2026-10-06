import type { AudioFormat } from '@winsendotai/ovo-contracts';

/** A typed provider failure. `status` is the HTTP status or the WebSocket close code. */
export class ElevenLabsTtsError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ElevenLabsTtsError';
  }
}

/** HTTP statuses worth one more attempt before the first byte: rate limit, voice warm-up, 5xx. */
export function retryableStatus(status: number): boolean {
  return status === 429 || status === 409 || status >= 500;
}

/**
 * Close 1008 is a policy refusal (bad key, quota, unknown voice): another socket gets the same
 * answer. A normal close or a server error may succeed on a fresh connection.
 */
export function retryableClose(code: number): boolean {
  return code !== 1008 && code !== 4001 && code !== 4003;
}

/**
 * Re-cuts provider chunks into whole samples. ElevenLabs base64 frames and HTTP body reads carry no
 * sample alignment guarantee, and a PCM16 byte split across two writes is a click on the line.
 */
export class SampleAligner {
  private carry?: number;
  private readonly width: number;

  constructor(format: AudioFormat) {
    this.width = format.encoding === 'pcm_s16le' ? 2 : 1;
  }

  push(bytes: Uint8Array): Uint8Array | undefined {
    if (this.width === 1) return bytes.byteLength ? bytes : undefined;
    let joined = bytes;
    if (this.carry !== undefined) {
      joined = new Uint8Array(bytes.byteLength + 1);
      joined[0] = this.carry;
      joined.set(bytes, 1);
      this.carry = undefined;
    }
    const whole = joined.byteLength - (joined.byteLength % 2);
    if (whole < joined.byteLength) this.carry = joined[whole];
    return whole ? joined.subarray(0, whole) : undefined;
  }

  /** True when a half sample is still held: the stream ended mid-sample. */
  get pending(): boolean {
    return this.carry !== undefined;
  }
}
