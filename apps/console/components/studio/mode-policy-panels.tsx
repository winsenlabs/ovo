'use client';
import type { AgentConfig, SessionIdentity } from '../../lib/api';
import { Panel, PanelHeader, StatusBadge } from '../primitives';
const modes: { id: AgentConfig['mode']; title: string; description: string; kind: string }[] = [
  {
    id: 'announcement',
    title: 'Announcement',
    description: 'Approved templates and validated variables.',
    kind: 'No LLM',
  },
  {
    id: 'faq',
    title: 'FAQ',
    description: 'Deterministic question matching and approved answers.',
    kind: 'No generative LLM',
  },
  {
    id: 'context',
    title: 'Supplied-context conversation',
    description: 'Bounded responses from supplied facts.',
    kind: 'LLM · tools off',
  },
  {
    id: 'agent',
    title: 'Tool-using agent',
    description: 'Approved reads and confirmed business actions.',
    kind: 'LLM + controlled tools',
  },
];

export function AgentModePanel({ config, role, update }: { config: AgentConfig; role: SessionIdentity['role']; update: (next: AgentConfig) => void }) {
  const selected = { config }; const identity = { role }; const applyUpdate = update;
  return (
          <Panel labelledBy="mode-title">
            <PanelHeader
              id="mode-title"
              title="01 · Agent mode"
              badge={<StatusBadge>4 modes</StatusBadge>}
            />
            <div className="panel-body">
              <fieldset className="mode-grid">
                <legend>Choose how this agent makes decisions.</legend>
                {modes.map((mode) => (
                  <label
                    className={`mode-card ${selected.config.mode === mode.id ? 'selected' : ''}`}
                    key={mode.id}
                  >
                    <span>
                      <input
                        type="radio"
                        name="mode"
                        checked={selected.config.mode === mode.id}
                        disabled={identity.role === 'viewer'}
                        onChange={() =>
                          applyUpdate({
                            ...selected.config,
                            mode: mode.id,
                            ...(mode.id === 'context' ? { allowedTools: [] } : {}),
                          })
                        }
                      />{' '}
                      <strong>{mode.title}</strong>
                    </span>
                    <p>{mode.description}</p>
                    <small>{mode.kind}</small>
                  </label>
                ))}
              </fieldset>
              <div className="muted">
                {selected.config.mode === 'announcement' || selected.config.mode === 'faq'
                  ? 'This mode does not require an LLM binding. Runtime tests must still prove zero model requests.'
                  : selected.config.mode === 'context'
                    ? 'Supplied-context mode begins with tools disabled.'
                    : 'Only exact approved tools are eligible at runtime.'}
              </div>
            </div>
          </Panel>
  );
}
export function RecordingPolicyPanel({ config, role, update }: { config: AgentConfig; role: SessionIdentity['role']; update: (next: AgentConfig) => void }) {
  const selected = { config }; const identity = { role }; const applyUpdate = update;
  return (
          <Panel labelledBy="recording-title">
            <PanelHeader
              id="recording-title"
              title="Recording and call policy"
              badge={<StatusBadge tone="warning">Partially available</StatusBadge>}
            />
            <div className="panel-body">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={selected.config.recording}
                  disabled={identity.role === 'viewer'}
                  onChange={(event) =>
                    applyUpdate({ ...selected.config, recording: event.target.checked })
                  }
                />
                <span>
                  <strong>Request recording for new releases</strong>
                  <small>
                    Carrier/legal preconditions and artifact state are validated outside AgentConfig
                    and are not yet exposed by this API.
                  </small>
                </span>
              </label>
              <div className="muted">
                Greeting, closing, transfer, DTMF, silence and retention controls are not in the
                current AgentConfig contract. The console does not invent settings for them.
              </div>
            </div>
          </Panel>
  );
}
