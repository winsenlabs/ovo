'use client';
import type { AgentConfig } from '../../lib/api';
import { ComplianceEditor } from './compliance-editor';
import { SpeechCacheEditor } from './speech-cache-editor';
import { TurnPacingEditor } from './turn-pacing-editor';

/**
 * How the agent paces turns (agent mode), what outbound compliance it observes, and which fixed
 * lines it caches, in that order: the studio mounts them as one block.
 */
export function CallPolicyPanels({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  return (
    <>
      {config.mode === 'agent' && <TurnPacingEditor config={config} update={update} />}
      <ComplianceEditor config={config} update={update} />
      <SpeechCacheEditor config={config} update={update} />
    </>
  );
}
