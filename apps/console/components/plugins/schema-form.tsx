'use client';
import { useState } from 'react';
import type { JsonShape, PluginOption } from './types';
import type { CredentialMetadata } from '../../lib/api';
import { JsonEditor } from '../forms/json-editor';
import { renderSchemaField, type FieldArgs } from './schema-field';

/** Above this many visible properties, a schema with no curated `ui.fields` hints (several
 * plugin kinds — engine, VAD, turn detector in the manifests seen so far — ship with none at
 * all) reads as an unnavigable flat dump of 15+ text inputs (brief §3 "Agent plugins": collapse
 * optional/advanced fields). Below it — every hand-authored binding schema the console ships
 * with today — every field stays exactly where it already was; this only engages for the
 * sprawling, hint-free case the brief's screenshots called out. */
const COLLAPSE_THRESHOLD = 6;

export function SchemaForm({
  plugin,
  schema = plugin.bindingSchema ?? plugin.configSchema,
  value,
  onChange,
  onSecret,
  fingerprints = {},
  credentials,
}: {
  plugin: PluginOption;
  schema?: JsonShape;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  onSecret?: (pointer: string, secret: string) => void | Promise<void>;
  fingerprints?: Record<string, string>;
  credentials?: readonly CredentialMetadata[];
}) {
  const [secretErrors, setSecretErrors] = useState<Record<string, string>>({});
  const requiredKeys = new Set(schema?.required ?? []);
  const patch = (key: string, next: unknown) => onChange({ ...value, [key]: next });
  const args: FieldArgs = {
    plugin,
    value,
    patch,
    onSecret,
    fingerprints,
    credentials,
    secretErrors,
    setSecretErrors,
    prefix: '',
    requiredKeys,
  };
  // A field hinted `advanced` stays filtered out of both groups below, same as before this pass —
  // it is reachable through the raw "Advanced JSON" editor, exactly as every existing test for it
  // (e.g. a secret pointer's non-secret sibling) already expects.
  const visible = Object.entries(schema?.properties ?? {}).filter(
    ([key]) => !plugin.ui?.fields?.[key]?.advanced,
  );
  const collapseOptional = visible.length > COLLAPSE_THRESHOLD;
  const primary = visible.filter(([key]) => !collapseOptional || requiredKeys.has(key));
  const collapsed = visible.filter(([key]) => collapseOptional && !requiredKeys.has(key));
  return (
    <div className="ui-stack">
      {primary.map((entry) => renderSchemaField(entry, args))}
      {collapsed.length > 0 && (
        <details className="ds-nested-fields">
          <summary>Advanced settings</summary>
          <div className="form-grid">
            {collapsed.map((entry) => renderSchemaField(entry, args))}
          </div>
        </details>
      )}
      <details>
        <summary>Advanced JSON</summary>
        <JsonEditor
          id={`schema-json-${plugin.id.replace(/[^a-z0-9-]/gi, '-')}`}
          value={value}
          onValid={(next) => onChange(next as Record<string, unknown>)}
        />
      </details>
    </div>
  );
}
