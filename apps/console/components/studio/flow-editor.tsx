'use client';
import { useMemo, useState } from 'react';
import { canonicalJson } from '@winsendotai/ovo-contracts';
import { Field } from '../primitives';
import { FlowLines } from './flow-lines';
import { FlowMap } from './flow-map';
import { flowIssues, importFlow, type Flow } from './flow-shapes';

/**
 * The state-aware conversation flow (AGT-1). Settings and line wording are edited here; the graph
 * itself (states, listen sets, intents) is imported or replaced as JSON, which is how the POC
 * conversation map comes in. Graph issues are shown live; errors block a release.
 */
export function FlowEditor({
  flow,
  onChange,
  onRemove,
}: {
  flow: Flow;
  onChange: (next: Flow) => void;
  onRemove: () => void;
}) {
  const issues = useMemo(() => flowIssues(flow), [flow]);
  const lineIds = Object.keys(flow.lines);
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return (
    <div className="stack">
      <p className="muted">
        {flow.nodes.length} states, {flow.listens.length} listen sets, {lineIds.length} lines. Each
        caller reply is matched against the current state&apos;s listen set, the global intents and
        an automatic &ldquo;other&rdquo;.
      </p>
      <div className="form-grid">
        <Field label="Start state" htmlFor="flow-start">
          <select
            id="flow-start"
            value={flow.start}
            onChange={(event) => onChange({ ...flow, start: event.target.value })}
          >
            {flow.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.id}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Use an intent at or above"
          htmlFor="flow-threshold"
          help="Confidence, 0 to 1. Below this the reply counts as unplaced."
        >
          <input
            id="flow-threshold"
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={flow.threshold}
            onChange={(event) => onChange({ ...flow, threshold: Number(event.target.value) })}
          />
        </Field>
        <Field label="A reply that fits nothing" htmlFor="flow-fallback">
          <select
            id="flow-fallback"
            value={flow.fallback}
            onChange={(event) =>
              onChange({ ...flow, fallback: event.target.value as Flow['fallback'] })
            }
          >
            <option value="llm">The LLM answers, then rejoins the flow</option>
            <option value="clarify">Ask the caller again (no LLM)</option>
          </select>
        </Field>
        <LinePicker
          id="flow-repeat-prefix"
          label="Said before a repeat"
          value={flow.repeatPrefix}
          lineIds={lineIds}
          onChange={(repeatPrefix) => onChange(withOptional(flow, 'repeatPrefix', repeatPrefix))}
        />
        {flow.fallback === 'clarify' && (
          <LinePicker
            id="flow-clarify"
            label="Asking again"
            value={flow.clarify}
            lineIds={lineIds}
            onChange={(clarify) => onChange(withOptional(flow, 'clarify', clarify))}
            none="The agent's clarification line"
          />
        )}
      </div>
      <Field
        label="Background for the decision model"
        htmlFor="flow-context"
        help="Who is calling whom, and why. Sent with every question; never spoken."
      >
        <textarea
          id="flow-context"
          value={flow.context ?? ''}
          onChange={(event) =>
            onChange(
              withOptional(
                flow,
                'context',
                event.target.value.trim() ? event.target.value : undefined,
              ),
            )
          }
        />
      </Field>
      {issues.length > 0 && (
        <div className={errors ? 'field-error' : 'muted'} role={errors ? 'alert' : 'status'}>
          <strong>
            {errors
              ? `${errors} issue${errors === 1 ? ' blocks' : 's block'} a release`
              : 'Warnings (a release is not blocked)'}
          </strong>
          <ul>
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                {issue.severity === 'error' ? 'Error' : 'Warning'} at {issue.path}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <FlowLines flow={flow} onChange={onChange} />
      <FlowMap flow={flow} />
      <FlowJson flow={flow} onChange={onChange} />
      <button className="text-button danger-text align-start" type="button" onClick={onRemove}>
        Remove flow
      </button>
    </div>
  );
}

function LinePicker({
  id,
  label,
  value,
  lineIds,
  onChange,
  none = 'Nothing',
}: {
  id: string;
  label: string;
  value: string | undefined;
  lineIds: string[];
  onChange: (next: string | undefined) => void;
  none?: string;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <select
        id={id}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">{none}</option>
        {lineIds.map((line) => (
          <option key={line} value={line}>
            {line}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Replace the whole graph from JSON, such as a converted POC conversation map. */
function FlowJson({ flow, onChange }: { flow: Flow; onChange: (next: Flow) => void }) {
  const [source, setSource] = useState('');
  const [error, setError] = useState<string>();
  return (
    <details className="import-box">
      <summary>Flow JSON (import or edit the whole map)</summary>
      <Field label="Flow JSON" htmlFor="flow-import" error={error}>
        <textarea
          id="flow-import"
          className="code-input"
          value={source}
          placeholder={canonicalJson(flow)}
          onChange={(event) => setSource(event.target.value)}
        />
      </Field>
      <div className="button-row">
        <button
          className="button"
          type="button"
          onClick={() => setSource(JSON.stringify(flow, null, 2))}
        >
          Load current flow
        </button>
        <button
          className="button"
          type="button"
          disabled={!source.trim()}
          onClick={() => {
            const imported = importFlow(source);
            if ('error' in imported) return setError(imported.error);
            setError(undefined);
            setSource('');
            onChange(imported.flow);
          }}
        >
          Validate and replace flow
        </button>
      </div>
    </details>
  );
}

function withOptional<K extends 'clarify' | 'repeatPrefix' | 'context'>(
  flow: Flow,
  key: K,
  value: Flow[K] | undefined,
): Flow {
  const next = { ...flow };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}
