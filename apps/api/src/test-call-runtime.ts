import { randomUUID } from 'node:crypto';
import { buildReleaseSelections } from './release-selections.ts';
import { createDefaultReleaseFactory, type DefaultSessionOptions } from './session-factory.ts';
import type { SessionDefaults } from '@winsendotai/ovo-session-host';
import type { PluginDefinition, Context } from '@winsendotai/ovo-runtime';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { createFixtureTelemetry } from '@winsendotai/ovo-plugin-observability';
import { Cap, type CarrierIngress } from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import {
  fixtureCarrierInboundFrame,
  persistFixtureUsage,
  runFixtureCall,
  withFixtureEgressSentinel,
} from '@winsendotai/ovo-fixture-calls';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadInstalledSessionExtensions } from '@winsendotai/ovo-session-host';
import { createFixtureRecordingPort, persistFixtureRecording } from './recording-runtime.ts';
import type { FixtureCallEvent, FixtureCallResult } from '@winsendotai/ovo-fixture-calls';
import type {
  ControlStore,
  CallRecord,
  ReleaseRecord,
  AgentDraft,
  ReleaseSelection,
} from '@winsendotai/ovo-plugin-storage';

/** D1-local capability until I1 integrates the frozen ControlStore interface. */
export interface FixtureAdmissionStore {
  createFixtureCall(
    input: {
      workspaceId: string;
      id: string;
      agentId: string;
      fingerprint: string;
    } & ({ releaseId: string } | { draft: Parameters<ControlStore['createRelease']>[0] }),
  ): Promise<
    | { created: true; call: CallRecord; release: ReleaseRecord }
    | { created: false; call: CallRecord }
  >;
  getFixtureCallRelease(workspaceId: string, callId: string): Promise<ReleaseRecord | undefined>;
}
export function fixtureAdmissionStore(store: ControlStore): FixtureAdmissionStore {
  const extension = store as ControlStore & Partial<FixtureAdmissionStore>;
  if (
    typeof extension.createFixtureCall !== 'function' ||
    typeof extension.getFixtureCallRelease !== 'function'
  )
    throw new Error('fixture_unavailable: atomic fixture admission storage is required');
  return extension as ControlStore & FixtureAdmissionStore;
}
export {
  fixtureCallsEnabled,
  fixtureCallsEnvironmentEnabled,
  idempotentFixtureCallId,
} from '@winsendotai/ovo-fixture-calls';

export { TestCallRuntime, runFixtureCallChild } from '@winsendotai/ovo-fixture-calls';
export type {
  FixtureChildJob,
  FixtureChildMessage,
  TestCallRuntimeOptions,
} from '@winsendotai/ovo-fixture-calls';
import type { FixtureChildJob } from '@winsendotai/ovo-fixture-calls';

/** Resolves the selected carrier inside the child under the fixture egress fence. */
export async function executeFixtureChildJob(
  job: FixtureChildJob,
  onEvent: (event: FixtureCallEvent) => void | Promise<void>,
): Promise<FixtureCallResult> {
  return withFixtureEgressSentinel(async () => {
    const distribution = await loadDistribution({
      role: 'api',
      profile: process.env.OVO_DEPLOYMENT_PROFILE === 'fargate' ? 'fargate' : 'compose',
      env: process.env,
    });
    const installedExtensions = await loadInstalledSessionExtensions(
      process.env.OVO_PLUGIN_MODULES,
    );
    const selected = job.release.selections?.carrier;
    if (!selected) throw new Error('fixture_unavailable: release has no selected carrier');
    const definition = distribution.catalog.find((item) => item.manifest.id === selected.pluginId);
    if (!definition || definition.manifest.version !== selected.version)
      throw new Error(
        `fixture_unavailable: selected carrier is not installed at ${selected.version}`,
      );
    if (
      definition.manifest.scope !== 'process' ||
      !manifestKeys(definition.manifest).provides.some((entry) => entry.key === Cap.carrierIngress)
    )
      throw new Error('fixture_unavailable: selected carrier has no ingress serializer');
    const carrier = await compose([{ id: selected.pluginId }], [definition], {
      scope: 'process',
      fixtures: true,
      net: createFixtureNet([]),
      enforcement: 'enforce',
    });
    try {
      const provider = manifestKeys(definition.manifest).manifest.provider;
      const ingress = carrier.all(Cap.carrierIngress).get(provider ?? selected.pluginId) as
        CarrierIngress | undefined;
      if (!ingress)
        throw new Error('fixture_unavailable: selected carrier did not provide ingress');
      const inboundFrame = fixtureCarrierInboundFrame(ingress);
      if (!inboundFrame)
        throw new Error(
          `fixture_unavailable: ${selected.pluginId} has no inbound fixture frame builder`,
        );
      const format = ingress.capabilities.media.formats[0];
      if (!format) throw new Error('fixture_unavailable: selected carrier has no recording format');
      return await runFixtureCall({
        callId: job.callId,
        release: job.release,
        registry: new PluginRegistry(distribution.catalog),
        fixtures: distribution.fixtures,
        fixtureTemplates: distribution.fixtureTemplates,
        carrier: { pluginId: selected.pluginId, ingress, inboundFrame },
        callerScript: job.callerScript,
        defaults: distribution.defaults,
        installedExtensions,
        parent: carrier,
        ...(job.release.config.recording ? { recording: createFixtureRecordingPort(format) } : {}),
        telemetry: { onEvent },
      }).done;
    } finally {
      await carrier.dispose();
    }
  });
}

export async function fixtureDraft(
  input: {
    store: ControlStore;
    catalog?: readonly PluginDefinition[];
    distributionDefaults?: SessionDefaults;
    options?: { defaultSession?: DefaultSessionOptions };
  },
  agent: AgentDraft,
  createdBy: string,
) {
  const generated = await createDefaultReleaseFactory(
    input.store,
    input.options?.defaultSession,
  )({
    agent,
    sessionId: randomUUID(),
    fixtureBindings: true,
  });
  const registry = new PluginRegistry([...(input.catalog ?? []), ...generated]);
  const selections = await buildReleaseSelections({
    agent,
    store: input.store,
    registry,
    defaults: input.distributionDefaults ?? {
      engine: '@winsendotai/ovo-plugin-voice-session-engine',
    },
  });
  const pinned: Record<string, ReleaseSelection> = {};
  for (const [slot, selection] of Object.entries(selections))
    if (selection) pinned[slot] = selection;
  return {
    workspaceId: agent.workspaceId,
    agent,
    plugins: generated.map(({ manifest }) => ({ id: manifest.id, version: manifest.version })),
    selections: pinned,
    createdBy,
  };
}

export async function persistFixtureResult(input: {
  result: FixtureCallResult;
  release: ReleaseRecord;
  workspaceId: string;
  callId: string;
  store: ControlStore;
  ctx?: Pick<Context, 'get'>;
  trace?: ReturnType<typeof createFixtureTelemetry>;
}) {
  const { result, release, workspaceId, callId, store, ctx, trace } = input;
  const recording = release.config.recording
    ? await persistFixtureRecording({
        context: ctx ?? ({ get: () => undefined } as Pick<Context, 'get'>),
        workspaceId: workspaceId,
        callId,
        payload: result.recording,
      })
    : undefined;
  const ledger = ctx?.get(Cap.costLedger) as CostLedgerService | undefined;
  await persistFixtureUsage({
    workspaceId: workspaceId,
    callId,
    meters: result.usage,
    priceCards: release.config.costPolicy?.priceCards,
    getPriceCard: ledger?.getPriceCard.bind(ledger),
    createId: randomUUID,
    writePriced: async (priced) => {
      const {
        sessionId: _sessionId,
        providerRequestId: requestId,
        rounding: _rounding,
        ...record
      } = priced;
      await store.addUsage({ ...record, callId, requestId });
    },
    writeMeter: (meter, key, unpriced) => {
      trace?.usage(meter);
      return store.appendCallEvent(workspaceId, callId, 'fixture.usage', {
        ...meter,
        key,
        unpriced,
      });
    },
  });
  await store.appendCallEvent(workspaceId, callId, 'fixture.result', {
    outcome: result.outcome,
    selections: result.selections,
    sttMode: result.sttMode,
    compatIssues: result.compatIssues,
    ...(recording === undefined ? {} : { recording }),
  });
  await store.finishCall(workspaceId, callId, result.status);
  trace?.ended(result.outcome.reason);
}

export function fixtureCallRelease(
  store: ControlStore,
  workspaceId: string,
  call: Pick<CallRecord, 'id' | 'kind' | 'releaseId'>,
) {
  const extension = store as ControlStore & Partial<FixtureAdmissionStore>;
  return call.kind === 'test' && typeof extension.getFixtureCallRelease === 'function'
    ? extension.getFixtureCallRelease(workspaceId, call.id)
    : store.getRelease(workspaceId, call.releaseId);
}
