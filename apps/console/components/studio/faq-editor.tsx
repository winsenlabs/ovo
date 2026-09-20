'use client';
import { useEffect, useState } from 'react';
import type { AgentConfig } from '../../lib/api';
import { EmptyState, Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';

type FaqRow = AgentConfig['faq'][number];

function ToolInput({
  id,
  value,
  onValid,
}: {
  id: string;
  value: Record<string, unknown>;
  onValid: (value: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string>();
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <>
      <textarea
        id={id}
        className="code-input compact-code"
        value={text}
        aria-invalid={Boolean(error)}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          try {
            const next: unknown = JSON.parse(text);
            if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error();
            onValid(next as Record<string, unknown>);
            setError(undefined);
          } catch {
            setError('Enter a valid JSON object.');
          }
        }}
      />
      {error && <small className="field-error">{error}</small>}
    </>
  );
}

function parseFaqImport(text: string): FaqRow[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error('FAQ import must be a JSON array.');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`FAQ ${index + 1} must be an object.`);
    const row = entry as Record<string, unknown>;
    if (typeof row.question !== 'string' || typeof row.answer !== 'string')
      throw new Error(`FAQ ${index + 1} requires question and answer text.`);
    if (row.aliases !== undefined && !Array.isArray(row.aliases))
      throw new Error(`FAQ ${index + 1} aliases must be an array.`);
    if (row.toolInput !== undefined && (!row.toolInput || typeof row.toolInput !== 'object'))
      throw new Error(`FAQ ${index + 1} toolInput must be an object.`);
    return {
      id: typeof row.id === 'string' && row.id ? row.id : crypto.randomUUID(),
      question: row.question,
      answer: row.answer,
      aliases: (row.aliases ?? []).map(String),
      ...(typeof row.requiresTool === 'string' && row.requiresTool
        ? { requiresTool: row.requiresTool }
        : {}),
      ...(row.toolInput ? { toolInput: row.toolInput as Record<string, unknown> } : {}),
    };
  });
}

export function FaqEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string>();
  const edit = (index: number, patch: Partial<FaqRow>) =>
    update({
      ...config,
      faq: config.faq.map((row, current) => (current === index ? { ...row, ...patch } : row)),
    });
  function applyImport() {
    try {
      update({ ...config, faq: parseFaqImport(importText) });
      setImportError(undefined);
      setImportText('');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'FAQ import is invalid.');
    }
  }
  return (
    <Panel labelledBy="faq-title">
      <PanelHeader
        id="faq-title"
        title="Approved FAQ answers"
        badge={<StatusBadge>{config.faq.length} entries</StatusBadge>}
      />
      <div className="panel-body stack">
        <details className="import-box">
          <summary>Import FAQ JSON</summary>
          <Field label="FAQ array" htmlFor="faq-import" error={importError}>
            <textarea
              id="faq-import"
              className="code-input"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              aria-invalid={Boolean(importError)}
            />
          </Field>
          <button
            className="button"
            type="button"
            onClick={applyImport}
            disabled={!importText.trim()}
          >
            Validate and replace FAQ
          </button>
        </details>
        {!config.faq.length && (
          <EmptyState title="No FAQ entries">
            Add approved answers or import a validated array. Tool execution remains opt-in per row.
          </EmptyState>
        )}
        {config.faq.map((row, index) => (
          <fieldset className="nested-card" key={row.id}>
            <legend>FAQ {index + 1}</legend>
            <div className="form-grid">
              <Field label="Stable ID" htmlFor={`faq-id-${index}`}>
                <input
                  id={`faq-id-${index}`}
                  value={row.id}
                  onChange={(event) => edit(index, { id: event.target.value })}
                />
              </Field>
              <Field label="Required tool (optional)" htmlFor={`faq-tool-${index}`}>
                <select
                  id={`faq-tool-${index}`}
                  value={row.requiresTool ?? ''}
                  onChange={(event) =>
                    edit(index, { requiresTool: event.target.value || undefined })
                  }
                >
                  <option value="">No tool</option>
                  {config.tools.map((tool) => (
                    <option key={tool.id} value={tool.id}>
                      {tool.id}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Question" htmlFor={`faq-q-${index}`}>
              <input
                id={`faq-q-${index}`}
                value={row.question}
                onChange={(event) => edit(index, { question: event.target.value })}
              />
            </Field>
            <Field label="Aliases (one per line)" htmlFor={`faq-a-${index}`}>
              <textarea
                id={`faq-a-${index}`}
                value={row.aliases.join('\n')}
                onChange={(event) =>
                  edit(index, {
                    aliases: event.target.value
                      .split('\n')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
            <Field label="Approved answer" htmlFor={`faq-answer-${index}`}>
              <textarea
                id={`faq-answer-${index}`}
                value={row.answer}
                onChange={(event) => edit(index, { answer: event.target.value })}
              />
            </Field>
            {row.requiresTool && (
              <Field label="Tool input JSON" htmlFor={`faq-tool-input-${index}`}>
                <ToolInput
                  id={`faq-tool-input-${index}`}
                  value={row.toolInput ?? {}}
                  onValid={(toolInput) => edit(index, { toolInput })}
                />
              </Field>
            )}
            <button
              className="text-button danger-text"
              type="button"
              onClick={() =>
                update({ ...config, faq: config.faq.filter((_, current) => current !== index) })
              }
            >
              Remove entry
            </button>
          </fieldset>
        ))}
        <Notice>
          Threshold and margin controls above determine whether an answer is safe to select; near
          ties use the clarification response.
        </Notice>
        <button
          className="button align-start"
          type="button"
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
