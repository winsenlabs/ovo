import {
  Cap,
  type Clock,
  type EngineEvent,
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
  return engine.subscribe((event) => {
    if (event.type === 'speech') {
      telemetry.adapter.speech(event.evidence);
      speech?.(event);
    } else if (event.type === 'timing') {
      telemetry.audit('session.timing', { key: event.key, atMs: event.atMs, ms: event.ms });
    } else if (event.type === 'user.transcript') {
      telemetry.audit('transcript.accepted', { text: event.text, turnId: event.turnId });
    } else if (event.type === 'agent.transcript') {
      telemetry.audit('transcript.agent', {
        segmentId: event.segmentId,
        text: event.text,
        state: event.state,
        spokenPrefix: event.spokenPrefix,
      });
    } else if (event.type === 'interrupt') {
      telemetry.audit('session.interrupt', { reason: event.reason });
    } else if (event.type === 'voicemail') {
      telemetry.audit('session.voicemail', { result: event.result });
    } else if (event.type === 'end') {
      telemetry.audit('session.engine-ended', { reason: event.reason });
    }
  });
}

export function sessionHostServices(input: {
  media: MediaDuplex;
  operationStore: OperationStore;
  secrets: SecretResolver;
  usage: UsageSink;
  transcripts: (
    event: Extract<EngineEvent, { type: 'user.transcript' | 'agent.transcript' }>,
  ) => void;
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
      provides: [Cap.operationStore, Cap.secrets, Cap.media, Cap.usage, Cap.transcripts, Cap.clock],
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
    },
  );
}
