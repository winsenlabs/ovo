import type { DurableJob } from '@winsendotai/ovo-plugin-orchestration';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { definePlugin } from '@winsendotai/ovo-runtime';

export const CALL_RECORDER_SERVICE_KEY = 'worker.call-recorder';

export interface CallRecorder {
  prepare(job: DurableJob, payload: Record<string, unknown>): Promise<void>;
}

export function createCallRecorderPlugin(store: ControlStore) {
  return definePlugin(
    {
      id: '@winsendotai/ovo-worker/call-recorder',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: [CALL_RECORDER_SERVICE_KEY],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      const recorder: CallRecorder = {
        async prepare(job, payload) {
          const releaseId = text(payload.releaseId, 'releaseId');
          const callId =
            typeof payload.callId === 'string' && payload.callId ? payload.callId : job.id;
          const release = await store.getRelease(job.workspaceId, releaseId);
          if (!release) throw new Error('immutable release not found before dial');
          const unsupportedBinding = Object.keys(release.providerBindings).find(
            (slot) => !['stt', 'tts', 'inference'].includes(slot),
          );
          if (unsupportedBinding)
            throw new Error(
              `release provider slot ${unsupportedBinding} is unsupported by the live worker; telephony is deployment-bound`,
            );
          const call = await store.getCall(job.workspaceId, callId);
          if (call) {
            if (call.kind !== 'live' || call.releaseId !== releaseId)
              throw new Error('existing call audit record does not match live release');
            return;
          }
          await store.createCall({
            id: callId,
            workspaceId: job.workspaceId,
            releaseId,
            kind: 'live',
            status: 'dialing',
          });
        },
      };
      ctx.provide(CALL_RECORDER_SERVICE_KEY, recorder);
    },
  );
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`job payload is missing ${field}`);
  return value;
}
