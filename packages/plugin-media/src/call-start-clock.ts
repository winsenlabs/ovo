import { timeoutReason, type CarrierMediaEvent, type EndReason } from '@winsendotai/ovo-contracts';
import type { GatewayToWorkerMessage } from './ports.ts';

/** OBS-9: where the call start was when a session closed, and how long each step took. */
export interface SessionBridgeTimings {
  phase: 'carrier_start' | 'route_resolve' | 'worker_dial' | 'accepted';
  carrierStartMs: number | null;
  routeResolveMs: number | null;
  workerDialMs: number | null;
}

/**
 * One handshake deadline covers the carrier start frame, route resolution and the worker dial.
 * The clock knows which of them was running, so the deadline's reason names that step instead of
 * blaming the carrier for all three (`carrier start timeout` did), and the close log carries each
 * step's duration.
 */
export class CallStartClock {
  phase: SessionBridgeTimings['phase'] = 'carrier_start';
  private readonly at: Partial<Record<SessionBridgeTimings['phase'] | 'opened', number>> = {
    opened: Date.now(),
  };

  mark(phase: Exclude<SessionBridgeTimings['phase'], 'carrier_start'>): void {
    this.phase = phase;
    this.at[phase] = Date.now();
  }

  /** The reason the handshake deadline closes with; idle media once the worker accepted. */
  deadlineReason(): EndReason {
    return timeoutReason(this.phase === 'accepted' ? 'media_idle' : this.phase);
  }

  timings(): SessionBridgeTimings {
    const between = (from?: number, to?: number) =>
      from === undefined || to === undefined ? null : to - from;
    return {
      phase: this.phase,
      carrierStartMs: between(this.at.opened, this.at.route_resolve),
      routeResolveMs: between(this.at.route_resolve, this.at.worker_dial),
      workerDialMs: between(this.at.worker_dial, this.at.accepted),
    };
  }
}

export const MEDIA_IDLE_TIMEOUT = timeoutReason('media_idle');

type MediaMessage = Exclude<GatewayToWorkerMessage, { type: 'session.open' | 'session.close' }>;

/** A carrier media event as the worker message it becomes, checked against the frame limits. */
export function carrierMediaMessage(
  event: Exclude<CarrierMediaEvent, { type: 'connected' | 'start' | 'stop' }>,
  input: {
    lastSequence: number;
    maxAudioFrameBytes: number;
    playbackEvidence: Extract<MediaMessage, { type: 'media.played' }>['evidence'];
  },
): { message: MediaMessage; audioBytes: number } {
  if (event.type === 'audio') {
    const audioBytes = event.payload.length;
    if (!audioBytes || audioBytes > input.maxAudioFrameBytes)
      throw new Error('carrier audio frame exceeds limit');
    if (!Number.isSafeInteger(event.seq) || event.seq <= input.lastSequence)
      throw new Error('carrier sequence is duplicate or out of order');
    const message: MediaMessage = {
      type: 'media.audio',
      payload: Buffer.from(event.payload).toString('base64'),
      sequenceNumber: event.seq,
      timestampMs: event.timestampMs,
    };
    return { message, audioBytes };
  }
  if (event.type === 'dtmf')
    return { message: { type: 'media.dtmf', digit: event.digit }, audioBytes: 0 };
  if (event.type === 'played')
    return {
      message: { type: 'media.played', name: event.name, evidence: input.playbackEvidence },
      audioBytes: 0,
    };
  return { message: { type: 'media.cleared' }, audioBytes: 0 };
}
