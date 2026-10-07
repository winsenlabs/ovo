import type {
  Behavior,
  BehaviorEvent,
  Clock,
  EngineEvent,
  SessionInput,
  SttConfigurationUpdate,
  TextFilter,
  TranscriptObserver,
} from '@winsendotai/ovo-contracts';
import type { BoundedSpeechScheduler } from '../scheduler.ts';
import type { VoiceEventBus } from './events.ts';
import type { TurnLatency } from './latency.ts';
import type { SpeechEventProjector } from './speech-events.ts';
import type { createTurnController } from './turn-controller-host.ts';

/** Points the scheduler at this session: pipeline depth, output limits, timing and text filters. */
export function configureScheduler(
  scheduler: BoundedSpeechScheduler,
  session: SessionInput,
  engine: { prefetchSegments?: number; maxPrefetchBytes?: number; markTimeoutMs?: number } = {},
  textFilters: readonly TextFilter[] = [],
  speechEvents: SpeechEventProjector,
): void {
  scheduler.configurePipeline(engine.prefetchSegments ?? 2);
  scheduler.configureSession(session);
  scheduler.configureOutput({
    maxPrefetchBytes: engine.maxPrefetchBytes,
    markTimeoutMs: engine.markTimeoutMs,
  });
  scheduler.configureTiming((phase, segment, elapsedMs) =>
    speechEvents.onTiming(phase, segment, elapsedMs),
  );
  scheduler.configureFilters(textFilters, session.language);
}

/**
 * Feeds every voice bus event to the turn controller, and projects caller transcripts into engine
 * events and latency marks.
 */
export function projectBusEvents(
  bus: VoiceEventBus,
  latency: TurnLatency,
  turnController: ReturnType<typeof createTurnController>,
  emit: (event: EngineEvent) => void,
): () => void {
  return bus.onEvent((event) => {
    if (event.type === 'vad.stop') latency.noteVadStop();
    if (event.type === 'stt' && event.event.type === 'transcript') {
      const segment = event.event.segment;
      if (segment.text.trim()) latency.noteWords(segment.text.trim());
      if (segment.stability === 'final') latency.noteFinalStt();
      emit({
        type: 'user.transcript',
        turnId: segment.segmentId,
        segmentId: segment.segmentId,
        text: segment.text,
        stability: segment.stability,
      });
    }
    turnController.observe(event);
  });
}

/**
 * Disposal's cleanup runner: every acquired port gets its cleanup attempt even when another hook
 * throws synchronously, and each failure goes to `failed`.
 */
export function cleanupAttempt(
  failed: (error?: unknown) => void,
): (cleanup: () => void | Promise<void>) => Promise<void> {
  return (cleanup) => {
    try {
      return Promise.resolve(cleanup()).catch(failed);
    } catch (error) {
      failed(error);
      return Promise.resolve();
    }
  };
}

/** What an engine reports before its ingress exists (input disabled, or not started yet). */
export function emptyIngressStats() {
  return { acceptedFrames: 0, acceptedBytes: 0, pendingFrames: 0, pendingBytes: 0, overflows: 0 };
}

/** Hands a transcript event to the observer. Inspection is never voice business authority. */
export function observeTranscript(
  observer: TranscriptObserver | undefined,
  event: EngineEvent,
  failed: (error: unknown) => void,
): void {
  if (event.type !== 'user.transcript' && event.type !== 'agent.transcript') return;
  try {
    observer?.(event);
  } catch (error) {
    failed(error);
  }
}

/**
 * A behaviour's `{ type: 'stt.configure', update }` event (STT-4): the endpointing for the flow
 * state it just entered. Any other behaviour event is projected onto the bus as before.
 */
export function sttConfigurationOf(event: { type: string }): SttConfigurationUpdate | undefined {
  if (event.type !== 'stt.configure') return undefined;
  const update = (event as { update?: unknown }).update;
  return update && typeof update === 'object' && !Array.isArray(update)
    ? (update as SttConfigurationUpdate)
    : undefined;
}

/**
 * Projects behaviour events onto the bus, except `stt.configure`, which retunes the provider's
 * endpointing instead (STT-4).
 */
export function observeBehavior(
  behavior: Behavior,
  bus: VoiceEventBus,
  clock: Clock,
  engine: { configureStt(update: SttConfigurationUpdate): unknown },
): () => void {
  return (
    behavior.subscribe?.((event) => {
      const update = sttConfigurationOf(event);
      if (update) return void engine.configureStt(update);
      // Compiles before and after BehaviorEvent lists `stt.configure` (handled just above).
      const type = event.type as Exclude<BehaviorEvent['type'], 'stt.configure'>;
      bus.observe({ type, atMs: clock.now() });
    }) ?? (() => undefined)
  );
}

/** The bound on an engine's disposal: `expired` rejects once `ms` pass, unless cleared first. */
export function disposalDeadline(ms: number): { expired: Promise<never>; clear(): void } {
  let timer!: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('engine disposal timeout')), ms);
    timer.unref?.();
  });
  // swallow-ok: the disposal awaiting it reports the timeout; a cleared deadline never rejects.
  expired.catch(() => undefined);
  return { expired, clear: () => clearTimeout(timer) };
}
