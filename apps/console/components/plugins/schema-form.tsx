'use client';
import { useState } from 'react';
import type { JsonShape, PluginOption } from './types';
import type { CredentialMetadata } from '../../lib/api';
import { JsonEditor } from '../forms/json-editor';
import { renderSchemaField, type FieldArgs } from './schema-field';

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
  const properties = Object.entries(schema?.properties ?? {});
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
    requiredKeys: new Set(schema?.required ?? []),
  };
  return (
    <div className="ui-stack">
      {properties
        .filter(([key]) => !plugin.ui?.fields?.[key]?.advanced)
        .map((entry) => renderSchemaField(entry, args))}
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
