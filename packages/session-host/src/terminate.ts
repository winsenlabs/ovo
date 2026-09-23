import type {
  CarrierCapabilities,
  EndReason,
  TelephonyControl,
  VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';

export interface TerminatingRoute {
  sessionId: string;
  carrierCallId?: string | null;
  carrierRequestId?: string | null;
}

export interface CarrierTerminationOptions {
  route: TerminatingRoute;
  store: { requestSessionTermination(route: TerminatingRoute): Promise<unknown> };
  control: TelephonyControl;
  capabilities: CarrierCapabilities;
  media: { terminate(sessionId: string): Promise<void> };
  engine: Pick<VoiceSessionEngine, 'dispose'>;
  reason: EndReason;
}

/** Fence the route before any purposeful carrier/media closure, then dispose the engine last. */
export async function terminateCarrierLeg(options: CarrierTerminationOptions): Promise<void> {
  const { route, store, control, media, engine, reason } = options;
  await store.requestSessionTermination(route);
  try {
    const outcome = await control.hangup({
      ...(route.carrierCallId ? { carrierCallId: route.carrierCallId } : {}),
      ...(route.carrierRequestId ? { carrierRequestId: route.carrierRequestId } : {}),
    });
    if (outcome === 'unsupported') {
      if (options.capabilities.control.hangup !== 'close-stream')
        throw new Error('REST carrier returned unsupported hangup');
      await media.terminate(route.sessionId);
    }
  } finally {
    await engine.dispose(reason);
  }
}
