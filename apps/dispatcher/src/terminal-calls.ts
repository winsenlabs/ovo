import type { Logger } from '@winsendotai/ovo-contracts';
import { errorFields } from '@winsendotai/ovo-plugin-kit';
import type { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';

/** One failing route is logged with its IDs and retried next tick; it never blocks the rest. */
export async function releaseTerminalCalls(
  store: Pick<
    PostgresOrchestrationStore,
    'listTerminalSessions' | 'get' | 'releaseTerminalSession'
  >,
  controlStore: Pick<ControlStore, 'getCall' | 'finishCall'>,
  log: Logger,
) {
  for (const route of await store.listTerminalSessions()) {
    try {
      const job = await store.get(route.jobId);
      if (job) {
        const callId =
          typeof job.payload.callId === 'string' && job.payload.callId
            ? job.payload.callId
            : job.id;
        if (await controlStore.getCall(job.workspaceId, callId))
          await controlStore.finishCall(job.workspaceId, callId, route.status);
      }
      await store.releaseTerminalSession(route.jobId);
    } catch (error) {
      log.warn('terminal_call_release_failed', {
        jobId: route.jobId,
        sessionId: route.sessionId,
        status: route.status,
        ...errorFields(error),
      });
    }
  }
}
