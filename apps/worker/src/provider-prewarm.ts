import type { Logger, NetPort, ReleaseSelections } from '@winsendotai/ovo-contracts';
import { errorFields, type NodeNet } from '@winsendotai/ovo-plugin-kit';
import type { DurableJobStore } from '@winsendotai/ovo-plugin-orchestration';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { PluginRegistry } from '@winsendotai/ovo-runtime';
import type { SessionDefaults } from '@winsendotai/ovo-session-host';
import { selectedReleaseSelections } from './cost-policy-support.ts';
import { workerHealth } from './worker-health.ts';

/** Exact egress hosts of every selected plugin, as https origins. Wildcard hosts are skipped. */
export function selectionOrigins(
  selections: ReleaseSelections,
  registry: Pick<PluginRegistry, 'get'>,
): string[] {
  const origins = new Set<string>();
  for (const selection of Object.values(selections)) {
    if (!selection) continue;
    const manifest = registry.get(selection.pluginId, selection.version)?.manifest;
    const hosts = (manifest as { runtime?: { egressHosts?: readonly string[] } } | undefined)
      ?.runtime?.egressHosts;
    for (const host of hosts ?? []) if (!host.includes('*')) origins.add(`https://${host}`);
  }
  return [...origins].sort();
}

function canPrewarm(net: NetPort | undefined): net is NodeNet {
  return typeof (net as Partial<NodeNet> | undefined)?.prewarm === 'function';
}

/**
 * LAT-8: opens pooled connections to the LLM, TTS, decision and STT hosts of a job's release while
 * the call is still ringing (outbound) or being admitted (inbound), so the first turn does not pay
 * DNS+TCP+TLS. Best effort: it never throws and never delays the call.
 */
export async function prewarmJobProviders(input: {
  jobId: string;
  net: NetPort | undefined;
  store: Pick<DurableJobStore, 'get'>;
  control: Pick<ControlStore, 'getRelease'>;
  registry: PluginRegistry;
  defaults?: SessionDefaults;
  log: Logger;
  timeoutMs?: number;
}): Promise<void> {
  const { net, log } = input;
  if (!canPrewarm(net)) return;
  try {
    const job = await input.store.get(input.jobId);
    const releaseId = job?.payload.releaseId;
    if (!job || typeof releaseId !== 'string') return;
    const release = await input.control.getRelease(job.workspaceId, releaseId);
    if (!release) return;
    const selections = selectedReleaseSelections(release, input.registry, input.defaults);
    const origins = selections ? selectionOrigins(selections, input.registry) : [];
    if (!origins.length) return;
    const results = await net.prewarm(origins, { timeoutMs: input.timeoutMs ?? 3_000 });
    // OBS-12: cached reachability per origin, named by the release slots that use it.
    workerHealth.prewarm(
      results.map(({ origin, ok, status, elapsedMs, error }) => ({
        origin,
        slots: Object.entries(selections ?? {})
          .filter(([slot, selection]) =>
            selection
              ? selectionOrigins({ [slot]: selection }, input.registry).includes(origin)
              : false,
          )
          .map(([slot]) => slot),
        ok,
        elapsedMs,
        ...(status === undefined ? {} : { status }),
        ...(error ? { error } : {}),
      })),
    );
    log.info('provider_prewarm', {
      jobId: input.jobId,
      origins: results.map(({ origin, ok, status, elapsedMs, error }) => ({
        origin,
        ok,
        status,
        elapsedMs,
        ...(error ? { error } : {}),
      })),
    });
  } catch (error) {
    log.warn('provider_prewarm_failed', { jobId: input.jobId, ...errorFields(error) });
  }
}
