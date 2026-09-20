'use client';
import { useEffect, useState } from 'react';
import type { ConsoleField } from '@winsendotai/ovo-ui';
import type { AgentConfig } from '../../lib/api';
import type { ProviderBinding } from '../../lib/api';
import { EmptyState, Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
function JsonField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string>();
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  function commit() {
    try {
      onChange(JSON.parse(text));
      setError(undefined);
    } catch {
      setError('Enter valid JSON before saving.');
    }
  }
  return (
    <>
      <textarea
        id={id}
        className="code-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-json-error` : undefined}
      />
      <small id={`${id}-json-error`} className="field-error">
        {error}
      </small>
    </>
  );
}

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
        <JsonField
          id={id}
          value={value}
          onChange={(next) => update(setPath(config, field.path, next))}
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

export function FaqEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  function edit(index: number, key: 'question' | 'answer' | 'aliases', value: string) {
    const faq = config.faq.map((row, current) =>
      current === index
        ? {
            ...row,
            [key]:
              key === 'aliases'
                ? value
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean)
                : value,
          }
        : row,
    );
    update({ ...config, faq });
  }
  return (
    <Panel labelledBy="faq-title">
      <PanelHeader
        id="faq-title"
        title="Approved FAQ answers"
        badge={<StatusBadge>{config.faq.length} entries</StatusBadge>}
      />
      <div className="panel-body stack">
        {config.faq.length === 0 && (
          <EmptyState title="No FAQ entries">
            Add an approved question and answer. A weak or near-tied match uses the clarification
            response.
          </EmptyState>
        )}
        {config.faq.map((row, index) => (
          <fieldset className="nested-card" key={row.id}>
            <legend>FAQ {index + 1}</legend>
            <Field label="Question" htmlFor={`faq-q-${index}`}>
              <input
                id={`faq-q-${index}`}
                value={row.question}
                onChange={(event) => edit(index, 'question', event.target.value)}
              />
            </Field>
            <Field label="Aliases (one per line)" htmlFor={`faq-a-${index}`}>
              <textarea
                id={`faq-a-${index}`}
                value={row.aliases.join('\n')}
                onChange={(event) => edit(index, 'aliases', event.target.value)}
              />
            </Field>
            <Field label="Approved answer" htmlFor={`faq-answer-${index}`}>
              <textarea
                id={`faq-answer-${index}`}
                value={row.answer}
                onChange={(event) => edit(index, 'answer', event.target.value)}
              />
            </Field>
            <button
              className="text-button danger-text"
              onClick={() =>
                update({ ...config, faq: config.faq.filter((_, current) => current !== index) })
              }
            >
              Remove entry
            </button>
          </fieldset>
        ))}
        <button
          className="button"
          onClick={() =>
            update({
              ...config,
              faq: [
                ...config.faq,
                { id: crypto.randomUUID(), question: '', aliases: [], answer: '' },
              ],
            })
          }
        >
          Add FAQ entry
        </button>
      </div>
    </Panel>
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
      ? ['stt', 'tts']
      : ['stt', 'tts', 'llm'];
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
