import {
  Cap,
  type Clock,
  type EngineEvent,
  type EventSink,
  type MediaDuplex,
  type OperationStore,
  type SecretResolver,
  type UsageSink,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import { definePlugin, type Composition, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';

export interface GraphSessionResult {
  composition: Composition;
  engine: VoiceSessionEngine;
  media: MediaDuplex;
}

export function subscribeEngineTelemetry(
  engine: VoiceSessionEngine,
  telemetry: WorkerSessionTelemetry,
  speech?: (event: Extract<EngineEvent, { type: 'speech' }>) => void,
): () => void {
  let reported = false;
  return engine.subscribe((event) => {
    try {
      recordEngineEvent(telemetry, event);
    } catch (error) {
      // Telemetry is never voice business authority: a failing recorder must not end the turn.
      // It is reported once per call so a broken recorder is visible without flooding the log.
      if (!reported)
        console.error(
          'worker telemetry error:',
          error instanceof Error ? error.message : String(error),
        );
      reported = true;
    }
    if (event.type === 'speech') speech?.(event);
  });
}

function recordEngineEvent(telemetry: WorkerSessionTelemetry, event: EngineEvent): void {
  telemetry.engineEvent?.(event);
  if (event.type === 'speech') telemetry.adapter.speech(event.evidence);
  // OBS-10: timings and transcripts are already in the engine.event row above (and the transcripts
  // port records accepted and agent lines once); writing them again doubled every call's rows.
  else if (event.type === 'timing') telemetry.adapter.timing(event);
  else if (event.type === 'interrupt') {
    telemetry.audit('session.interrupt', { reason: event.reason });
  } else if (event.type === 'voicemail') {
    telemetry.audit('session.voicemail', { result: event.result });
  } else if (event.type === 'end') {
    telemetry.audit('session.engine-ended', {
      reason: event.reason,
      ...(event.detail ? { detail: event.detail } : {}),
    });
  }
}

export function sessionHostServices(input: {
  media: MediaDuplex;
  operationStore: OperationStore;
  secrets: SecretResolver;
  usage: UsageSink;
  transcripts: (
    event: Extract<EngineEvent, { type: 'user.transcript' | 'agent.transcript' }>,
  ) => void;
  /** The call's outcome event sink (AGT-8); without one, behaviours record nothing. */
  events?: EventSink;
}): PluginDefinition {
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const timer = globalThis.setTimeout(fn, ms);
      return () => globalThis.clearTimeout(timer);
    },
  };
  return definePlugin(
    {
      id: '@winsendotai/ovo-worker/session-host-services',
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'host',
      requires: [],
      provides: [
        Cap.operationStore,
        Cap.secrets,
        Cap.media,
        Cap.usage,
        Cap.transcripts,
        Cap.clock,
        ...(input.events ? [Cap.events] : []),
      ],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.operationStore, input.operationStore);
      ctx.provide(Cap.secrets, input.secrets);
      ctx.provide(Cap.media, input.media);
      ctx.provide(Cap.usage, input.usage);
      ctx.provide(Cap.transcripts, input.transcripts);
      ctx.provide(Cap.clock, clock);
      if (input.events) ctx.provide(Cap.events, input.events);
    },
  );
}
