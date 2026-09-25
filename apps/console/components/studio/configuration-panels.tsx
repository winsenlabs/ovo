'use client';
import type { ConsoleField } from '@winsendotai/ovo-ui';
import type { AgentConfig } from '../../lib/api';
import type { ProviderBinding } from '../../lib/api';
import { Field, Panel, PanelHeader, StatusBadge } from '../primitives';
import { JsonEditor } from '../forms/json-editor';

function getPath(config: AgentConfig, path: ConsoleField['path']): unknown {
  if (path.startsWith('processing.'))
    return config.processing[path.slice('processing.'.length) as keyof AgentConfig['processing']];
  return config[path as keyof AgentConfig];
}

function setPath(config: AgentConfig, path: ConsoleField['path'], value: unknown): AgentConfig {
  if (path.startsWith('processing.'))
    return {
      ...config,
      processing: { ...config.processing, [path.slice('processing.'.length)]: value },
    };
  return { ...config, [path]: value } as AgentConfig;
}

export function PluginField({
  field,
  config,
  update,
}: {
  field: ConsoleField;
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const id = `agent-${field.path.replace('.', '-')}`;
  const value = getPath(config, field.path);
  if (field.kind === 'json')
    return (
      <Field label={field.label} htmlFor={id} help={field.help}>
        <JsonEditor
          id={id}
          value={value}
          objectOnly={false}
          onValid={(next) => update(setPath(config, field.path, next))}
        />
      </Field>
    );
  if (field.kind === 'switch')
    return (
      <label className="toggle-row" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => update(setPath(config, field.path, event.target.checked))}
        />
        <span>{field.label}</span>
      </label>
    );
  const common = {
    id,
    value: String(value ?? ''),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      update(
        setPath(
          config,
          field.path,
          field.kind === 'number' ? Number(event.target.value) : event.target.value,
        ),
      ),
  };
  return (
    <Field label={field.label} htmlFor={id} help={field.help}>
      {field.kind === 'textarea' ? (
        <textarea {...common} />
      ) : (
        <input
          {...common}
          type={field.kind === 'number' ? 'number' : 'text'}
          min={field.min}
          max={field.max}
          step={field.max === 1 ? '0.01' : undefined}
        />
      )}
    </Field>
  );
}

export function ProviderMap({
  config,
  bindings,
  update,
}: {
  config: AgentConfig;
  bindings: ProviderBinding[];
  update: (next: AgentConfig) => void;
}) {
  const slots =
    config.mode === 'announcement' || config.mode === 'faq'
      ? ['stt', 'tts', 'telephony']
      : ['stt', 'tts', 'inference', 'telephony'];
  return (
    <Panel labelledBy="provider-map-title">
      <PanelHeader
        id="provider-map-title"
        title="Provider bindings"
        badge={
          <StatusBadge tone={bindings.length ? 'soft' : 'warning'}>
            {bindings.length ? 'Metadata loaded' : 'Not configured'}
          </StatusBadge>
        }
      />
      <div className="panel-body form-grid">
        {slots.map((slot) => (
          <Field
            key={slot}
            label={`${slot.toUpperCase()} binding`}
            htmlFor={`provider-${slot}`}
            help="Only API-returned binding references are stored in the draft."
          >
            <select
              id={`provider-${slot}`}
              value={config.providers[slot] ?? ''}
              onChange={(event) =>
                update({
                  ...config,
                  providers: { ...config.providers, [slot]: event.target.value },
                })
              }
            >
              <option value="">Not bound</option>
              {bindings.map((binding) => (
                <option key={binding.id} value={binding.id}>
                  {binding.label} · {binding.environment}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>
    </Panel>
  );
}
