import type { CompatIssue, ReleaseSelections } from '@winsendotai/ovo-contracts';
import type { AgentDraft, ControlStore, ProviderBinding } from '@winsendotai/ovo-plugin-storage';
import { validateSelections, type SessionDefaults } from '@winsendotai/ovo-session-host';
import type { PluginRegistry } from '@winsendotai/ovo-runtime';
import type { InfrastructureService } from './infrastructure-types.ts';

/** Advisory snapshot; live admission rechecks the immutable release and worker lease. */
export async function liveReadiness(
  agent: AgentDraft,
  store: ControlStore,
  registry: PluginRegistry,
  selections: ReleaseSelections,
  infrastructure?: InfrastructureService,
  bindings?: Readonly<Record<string, ProviderBinding>>,
  defaults?: SessionDefaults,
) {
  const details: CompatIssue[] = validateSelections(
    {
      config: agent.config,
      selections,
      registry,
      priceCards: agent.config.costPolicy?.priceCards,
      bindings,
      defaults,
    },
    'live',
  );
  const add = (message: string, field?: string) =>
    details.push({
      code: 'runtime_incompatible',
      severity: 'error',
      stage: 'live',
      message,
      field,
    });
  if (!infrastructure || infrastructure.organizationId !== agent.workspaceId)
    add('Infrastructure readiness service is unavailable.', 'infrastructure');
  else {
    const snapshot = await infrastructure.snapshot(agent.workspaceId);
    if (snapshot.installation.status !== 'ready')
      for (const reason of snapshot.installation.reasons) add(reason, 'infrastructure');
    if (!snapshot.installation.enabled)
      add('Live dialing is disabled for this installation.', 'infrastructure');
  }
  if (!agent.config.costPolicy)
    add('A live-call budget and maximum duration policy are required.', 'costPolicy');
  for (const [slot, choice] of Object.entries(selections)) {
    if (!choice?.bindingId || choice.bindingId === 'env') continue;
    const binding = await store.getProviderBinding(agent.workspaceId, choice.bindingId);
    const credential =
      binding && (await store.getCredential(agent.workspaceId, binding.credentialId));
    if (
      !binding ||
      !credential ||
      credential.status !== 'active' ||
      (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) ||
      credential.environment !== binding.environment ||
      (credential.permittedAgentIds.length && !credential.permittedAgentIds.includes(agent.id))
    )
      add(`The ${slot} credential is unavailable, expired, or not permitted for this agent.`, slot);
  }
  const liveBlockers = [
    ...new Set(details.filter((issue) => issue.severity === 'error').map((issue) => issue.message)),
  ];
  return {
    liveReady: liveBlockers.length === 0,
    liveBlockers,
    details,
    admissionSafety:
      'Advisory only. Admission must revalidate the immutable release, reserve a fresh worker, and obtain protection before dialing.',
  };
}
