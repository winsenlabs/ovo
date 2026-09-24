import type {
  CarrierCapabilities,
  EndReason,
  TelephonyControl,
  VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';

export interface TerminatingRoute {
  sessionId: string;
  jobId: string;
  workerId: string;
  ownerEpoch: number;
  carrierCallId?: string | null;
  carrierRequestId?: string | null;
}

export interface CarrierTerminationOptions {
  route: TerminatingRoute;
  store: {
    requestSessionTermination(
      route: Pick<TerminatingRoute, 'sessionId' | 'jobId' | 'workerId' | 'ownerEpoch'>,
      reason: string,
    ): Promise<{ carrierCallId?: string; carrierRequestId?: string } | undefined>;
  };
  control: TelephonyControl;
  capabilities: CarrierCapabilities;
  media: { terminate(sessionId: string, reason: EndReason): Promise<void> };
  engine: Pick<VoiceSessionEngine, 'dispose'>;
  reason: EndReason;
}

/** Fence the route before any purposeful carrier/media closure, then dispose the engine last. */
export async function terminateCarrierLeg(options: CarrierTerminationOptions): Promise<void> {
  const { route, store, control, media, engine, reason } = options;
  try {
    const fenced = await store.requestSessionTermination(route, reason);
    if (!fenced) throw new Error(`Session ${route.sessionId} termination fence failed`);
    const query = {
      ...((fenced.carrierCallId ?? route.carrierCallId)
        ? { carrierCallId: fenced.carrierCallId ?? route.carrierCallId! }
        : {}),
      ...((fenced.carrierRequestId ?? route.carrierRequestId)
        ? { carrierRequestId: fenced.carrierRequestId ?? route.carrierRequestId! }
        : {}),
    };
    if (options.capabilities.control.hangup === 'close-stream') {
      try {
        await control.hangup(query);
      } catch {
        // The carrier control path can fail while its media stream remains open.
      }
      await media.terminate(route.sessionId, reason);
    } else {
      const outcome = await control.hangup(query);
      if (outcome === 'unsupported') throw new Error('REST carrier returned unsupported hangup');
    }
  } finally {
    await engine.dispose(reason);
  }
}
