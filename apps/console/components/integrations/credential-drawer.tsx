'use client';
import { useEffect, useState } from 'react';
import type { AgentDraft } from '../../lib/api';
import type { PluginOption } from '../plugins/types';
import { Drawer } from '../ui/drawer';
import { FormField } from '../ui/form-field';
import { Select } from '../ui/inputs';

const CREDENTIAL_TYPES = [
  { value: 'stt', label: 'Speech to text' },
  { value: 'tts', label: 'Text to speech' },
  { value: 'llm', label: 'LLM' },
  { value: 'carrier', label: 'Carrier' },
  { value: 'tool', label: 'Tool API' },
];
const ENVIRONMENTS = [
  { value: 'test', label: 'Test' },
  { value: 'production', label: 'Production' },
];

const EMPTY = {
  label: '',
  pluginId: '',
  type: 'stt',
  environment: 'test',
  value: '',
  expiresAt: '',
};

export function CredentialDrawer({
  open,
  plugins,
  agents,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  plugins: PluginOption[];
  agents: AgentDraft[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    label: string;
    pluginId: string;
    type: string;
    environment: string;
    value: string;
    expiresAt?: string;
    permittedAgentIds: string[];
  }) => Promise<void>;
}) {
  const [draft, setDraft] = useState(EMPTY);
  const [permitted, setPermitted] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      setDraft(EMPTY);
      setPermitted([]);
    }
  }, [open]);
  const patch = (value: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...value }));

  return (
    <Drawer open={open} title="Add write-only credential" onClose={onClose}>
      <form
        className="stack"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit({ ...draft, permittedAgentIds: permitted });
        }}
      >
        <p className="muted">
          No reveal action exists. The value is cleared after a successful save and must never
          appear in API metadata.
        </p>
        <FormField id="credential-label" label="Label">
          {(props) => (
            <input
              {...props}
              value={draft.label}
              onChange={(e) => patch({ label: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          id="credential-plugin"
          label="Plugin"
          help="Which installed adapter this key authenticates."
        >
          {(props) => (
            <Select
              {...props}
              value={draft.pluginId}
              onChange={(value) => patch({ pluginId: value })}
              placeholder="Select installed plugin"
              options={plugins.map((plugin) => ({
                value: plugin.id,
                label: plugin.ui?.label ?? plugin.id,
              }))}
            />
          )}
        </FormField>
        <div className="form-grid">
          <FormField id="credential-type" label="Credential type">
            {(props) => (
              <Select
                {...props}
                value={draft.type}
                onChange={(value) => patch({ type: value })}
                options={CREDENTIAL_TYPES}
              />
            )}
          </FormField>
          <FormField id="credential-environment" label="Environment">
            {(props) => (
              <Select
                {...props}
                value={draft.environment}
                onChange={(value) => patch({ environment: value })}
                options={ENVIRONMENTS}
              />
            )}
          </FormField>
        </div>
        <FormField
          id="credential-value"
          label="Credential value"
          help="Sent once to the management API over this same-origin gateway."
          required
        >
          {(props) => (
            <input
              {...props}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={draft.value}
              onChange={(e) => patch({ value: e.target.value })}
            />
          )}
        </FormField>
        <FormField id="credential-expiry" label="Expiry (optional)">
          {(props) => (
            <input
              {...props}
              type="datetime-local"
              value={draft.expiresAt}
              onChange={(e) => patch({ expiresAt: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          id="credential-agents"
          label="Permitted agents (optional)"
          help="Leave empty for no restriction; hold Cmd/Ctrl to select several."
        >
          {(props) => (
            <select
              {...props}
              multiple
              value={permitted}
              onChange={(e) =>
                setPermitted([...e.target.selectedOptions].map((option) => option.value))
              }
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.config.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <div className="button-row">
          <button
            type="submit"
            className="button primary"
            disabled={busy || !draft.label || !draft.pluginId || !draft.value}
          >
            {busy ? 'Saving…' : 'Save credential'}
          </button>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
}
