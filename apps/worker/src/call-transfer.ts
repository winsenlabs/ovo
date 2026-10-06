import type { HandoffTarget } from '@winsendotai/ovo-contracts';
import type { DurableJob } from '@winsendotai/ovo-plugin-orchestration';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';

/**
 * Where a call goes when its agent ended it `transferred` (AGT-15): the transfer target of the
 * release the job ran. Read only on that ending, so no other call pays for the lookup. Undefined
 * when the release has none, and the call is then hung up as any other.
 */
export async function releaseTransferTarget(
  store: Pick<ControlStore, 'getRelease'>,
  job: Pick<DurableJob, 'workspaceId' | 'payload'>,
): Promise<HandoffTarget | undefined> {
  const releaseId = job.payload.releaseId;
  if (typeof releaseId !== 'string' || !releaseId) return undefined;
  const release = await store.getRelease(job.workspaceId, releaseId);
  return release?.config.handoff?.transfer?.target;
}
