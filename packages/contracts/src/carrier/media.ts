import type { AudioFormat } from '../audio.ts';
import type { ResolvedBinding } from './control.ts';

export type CarrierMediaEvent =
  | { type: 'connected' }
  | {
      type: 'start';
      carrierCallId: string;
      streamId: string;
      format: AudioFormat;
      routeParams: Record<string, string>;
    }
  | { type: 'audio'; seq: number; timestampMs: number; payload: Uint8Array }
  | { type: 'dtmf'; digit: string; durationMs?: number }
  | { type: 'played'; name: string }
  | { type: 'cleared' }
  | { type: 'stop'; reason: 'caller-hangup' | 'stream-ended' | 'unknown' };

export type MediaCommand =
  { type: 'audio'; payload: Uint8Array } | { type: 'mark'; name: string } | { type: 'clear' };

export interface UpgradeRequest {
  /** The full request URL INCLUDING its query (Exotel carries sid/rt/t there). */
  url: URL;
  /** Public origin (+ explicit non-default port) + exact path, NO query. */
  externalUrl: string;
  headers: Readonly<Record<string, string | undefined>>;
  remoteAddress?: string;
}

export interface MediaSerializer {
  authenticateUpgrade(
    req: UpgradeRequest,
    ctx: {
      bindingId: string;
      resolveBinding(id: string): Promise<ResolvedBinding>;
      verifyUrlSecret(input: {
        purpose: 'media';
        bindingId: string;
        requestId?: string;
        token: string | null;
      }): boolean;
    },
  ): Promise<{ ok: true; params: Record<string, string> } | { ok: false; status: 401 | 403 }>;
  createSession(params: Record<string, string>): MediaCodecSession;
}

export interface MediaCodecSession {
  /** Throws `CarrierProtocolError` on a malformed frame. */
  decode(text: string): CarrierMediaEvent[];
  /** Owns chunking (Exotel: 320 B multiples, at least 3,200 B, at most 100 KB). */
  encode(command: MediaCommand): string[];
  /** Pads and emits the remainder before a mark or close. */
  flush(): string[];
  /** Frames to send before a deliberate close (optional). */
  terminate?(): string[];
}

/** A carrier frame or request that does not follow the documented protocol. */
export class CarrierProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CarrierProtocolError';
  }
}
