import type { AgentDraft, ControlStore } from '@winsendotai/ovo-plugin-storage';
import {
  deepgramBindingFromRecord,
  openAiTtsBindingFromRecord,
} from '@winsendotai/ovo-plugin-providers';
import type { InfrastructureService } from './infrastructure-types.ts';

/** Advisory configuration snapshot only: it never reserves a worker or authorizes dialing. */
export async function liveReadiness(
  agent: AgentDraft,
  store: ControlStore,
  infrastructure?: InfrastructureService,
) {
  const blockers: string[] = [];
  if (!infrastructure || infrastructure.organizationId !== agent.workspaceId)
    blockers.push('Infrastructure readiness service is unavailable.');
  else {
    const snapshot = await infrastructure.snapshot(agent.workspaceId);
    if (snapshot.installation.status !== 'ready') blockers.push(...snapshot.installation.reasons);
    if (!snapshot.installation.enabled)
      blockers.push('Live dialing is disabled for this installation.');
  }
  if (!agent.config.costPolicy)
    blockers.push('A live-call budget and maximum duration policy are required.');
  const roles = [
    'tts',
    ...(agent.config.mode !== 'announcement' || agent.config.script ? ['stt'] : []),
  ];
  for (const role of roles) {
    const id = agent.config.providers[role];
    const binding = id ? await store.getProviderBinding(agent.workspaceId, id) : undefined;
    if (!binding) {
      blockers.push(`A ${role} binding is required for live calls.`);
      continue;
    }
    try {
      if (role === 'stt') deepgramBindingFromRecord(binding);
      else openAiTtsBindingFromRecord(binding);
      const credential = await store.getCredential(agent.workspaceId, binding.credentialId);
      if (
        !credential ||
        credential.status !== 'active' ||
        (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) ||
        credential.environment !== binding.environment ||
        (credential.permittedAgentIds.length && !credential.permittedAgentIds.includes(agent.id))
      )
        blockers.push(
          `The ${role} credential is unavailable, expired, or not permitted for this agent.`,
        );
    } catch {
      blockers.push(
        `The ${role} provider configuration is incompatible with the installed live profile.`,
      );
    }
  }
  return {
    liveReady: blockers.length === 0,
    liveBlockers: [...new Set(blockers)],
    admissionSafety:
      'Advisory only. Admission must revalidate the immutable release, reserve a fresh worker, and obtain protection before dialing.',
  };
}
