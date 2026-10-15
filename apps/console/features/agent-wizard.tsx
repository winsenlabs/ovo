'use client';
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentVoice } from '@winsendotai/ovo-contracts';
import {
  apiRequest,
  emptyAgentConfig,
  ifMatch,
  normalizeDraft,
  type AgentConfig,
} from '../lib/api';
import type { PluginCatalog } from '../components/plugins/types';
import { useSession } from '../components/shell/session-provider';
import { PageHeader } from '../components/ui/layout';
import { Stepper, type StepState } from '../components/ui/stepper';
import { InlineAlert } from '../components/ui/feedback-v2';
import { useResource } from '../lib/data/use-resource';
import { useMutation } from '../lib/data/use-mutation';
import { resources } from '../lib/data/resources';
import { WizardBasicsStep, WizardBehaviorStep, WizardPluginsStep } from './agent-wizard-steps';

const STEP_LABELS = ['Basics', 'Plugins', 'Behavior'] as const;

function stepStates(current: number): { label: string; state: StepState }[] {
  return STEP_LABELS.map((label, index) => ({
    label,
    state: index < current ? 'done' : index === current ? 'current' : 'upcoming',
  }));
}

export function AgentWizardFeature() {
  const router = useRouter();
  const identity = useSession();
  const workspaceKey =
    identity.workspaceId ?? identity.workspace?.id ?? identity.id ?? identity.email ?? 'unknown';
  const catalogResource = useResource(`plugins:${workspaceKey}`, resources.plugins);
  const catalog: PluginCatalog =
    catalogResource.status === 'ready' ? catalogResource.data : { plugins: [] };
  const invalidates = useMemo(() => [`agents:${workspaceKey}`], [workspaceKey]);
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<AgentConfig>(() => emptyAgentConfig());
  const voice: AgentVoice = config.voice ?? { textFilters: [], acknowledgements: [] };
  const createAgent = useCallback(async (next: AgentConfig) => {
    const initial = await apiRequest<unknown>('/agents', {
      method: 'POST',
      body: JSON.stringify({ config: emptyAgentConfig() }),
    });
    const draft = normalizeDraft(initial.data, initial.etag);
    await apiRequest(`/agents/${encodeURIComponent(draft.id)}`, {
      method: 'PUT',
      headers: { 'if-match': ifMatch(draft.draftVersion) },
      body: JSON.stringify({ config: next }),
    });
    return draft.id;
  }, []);
  const createMutation = useMutation(createAgent, invalidates);
  async function create() {
    try {
      const id = await createMutation.run(config);
      router.push(`/agents/${encodeURIComponent(id)}/plugins`);
    } catch {
      /* The mutation exposes its error. */
    }
  }

  return (
    <div className="ui-stack">
      <PageHeader
        eyebrow="Create agent"
        title="New voice agent"
        description="Name the agent, choose installed plugins, then add the behavior essentials."
      />
      <Stepper steps={stepStates(step)} />
      {catalogResource.status === 'error' && (
        <InlineAlert tone="danger">{catalogResource.error}</InlineAlert>
      )}
      {createMutation.error && <InlineAlert tone="danger">{createMutation.error}</InlineAlert>}

      {step === 0 && <WizardBasicsStep config={config} onChange={setConfig} />}
      {step === 1 && (
        <WizardPluginsStep
          config={config}
          voice={voice}
          plugins={catalog.plugins}
          onChange={setConfig}
        />
      )}
      {step === 2 && <WizardBehaviorStep config={config} onChange={setConfig} />}

      <div className="ds-wizard-footer">
        <span className="muted">
          {step < 2
            ? 'Nothing is saved until the last step.'
            : 'Creating the agent saves this draft and opens its plugin choices.'}
        </span>
        <div className="ui-cluster">
          {step > 0 && (
            <button className="button" type="button" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step < 2 ? (
            <button
              className="button primary"
              type="button"
              disabled={step === 0 && !config.name.trim()}
              onClick={() => setStep(step + 1)}
            >
              Continue
            </button>
          ) : (
            <button
              className="button primary"
              type="button"
              disabled={createMutation.pending || identity.role === 'viewer' || !config.name.trim()}
              onClick={() => void create()}
            >
              {createMutation.pending ? 'Creating…' : 'Create agent'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
