'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest, type CredentialMetadata, type ProviderBinding } from '../../lib/api';
import { Drawer } from '../ui/drawer';
import { FormField } from '../ui/form-field';
import { SchemaForm } from './schema-form';
import type { PluginOption } from './types';

type CarrierUrl = { purpose: string; label?: string; url: string };
export function carrierOperatorUrls(value: unknown): CarrierUrl[] {
  const items = value && typeof value === 'object' && 'items' in value ? value.items : undefined;
  if (!Array.isArray(items) || items.some(item => !item || typeof item.purpose !== 'string' || typeof item.url !== 'string'))
    throw new Error('Carrier URL response is invalid.');
  return items as CarrierUrl[];
}
export function BindingSelect({ plugin, bindings, credentials, value, onChange, onCreated }: {
  plugin: PluginOption; bindings: readonly ProviderBinding[]; credentials: readonly CredentialMetadata[];
  value?: string; onChange: (id?: string) => void; onCreated?: (binding: ProviderBinding) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [urls, setUrls] = useState<CarrierUrl[]>([]);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const filtered = bindings.filter(binding => binding.pluginId === plugin.id);
  useEffect(() => {
    if (plugin.kind !== 'carrier' || !value) { setUrls([]); return; }
    let active = true;
    void apiRequest<unknown>(`/provider-bindings/${encodeURIComponent(value)}/carrier-urls`)
      .then(({ data }) => { if (active) setUrls(carrierOperatorUrls(data)); })
      .catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'Carrier URLs unavailable'); });
    return () => { active = false; };
  }, [plugin.kind, value]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      const { data } = await apiRequest<ProviderBinding>('/provider-bindings', { method: 'POST', body: JSON.stringify({
        label, provider: plugin.provider, pluginId: plugin.id, environment: 'production', credentialId, config,
      }) });
      onCreated?.(data); onChange(data.id); setOpen(false); setConfig({}); setLabel(''); setCredentialId('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Binding creation failed'); }
  }
  return <div className="ui-stack"><div className="ui-cluster">
    <FormField id={`binding-${plugin.kind}`} label="Binding">{props => <select {...props} value={value ?? ''} onChange={event => onChange(event.target.value || undefined)}>
      <option value="">Environment binding</option>{filtered.map(binding => <option key={binding.id} value={binding.id}>{binding.label}</option>)}
    </select>}</FormField>
    <button className="button" type="button" onClick={() => setOpen(true)}>Create binding</button>
  </div>
    {error && <p role="alert">{error}</p>}
    {plugin.kind === 'carrier' && value && <section><h3>Operator URLs</h3><p>Paste these URLs into your carrier console.</p>
      {urls.map(item => <div className="ui-cluster" key={item.purpose}><span>{item.label ?? item.purpose}</span><code className="mono">{item.url}</code>
        <button type="button" className="button" onClick={() => void navigator.clipboard.writeText(item.url).then(() => setCopied(item.purpose))}>{copied === item.purpose ? 'Copied' : 'Copy'}</button></div>)}
    </section>}
    <Drawer open={open} title={`Create ${plugin.ui?.label ?? plugin.provider} binding`} onClose={() => setOpen(false)}>
      <form className="ui-stack" onSubmit={create}>
        <FormField id="new-binding-label" label="Label" required>{props => <input {...props} value={label} onChange={event => setLabel(event.target.value)} />}</FormField>
        <FormField id="new-binding-credential" label="Credential" required>{props => <select {...props} value={credentialId} onChange={event => setCredentialId(event.target.value)}><option value="">Select credential</option>{credentials.filter(item => item.provider === plugin.provider).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}</FormField>
        <SchemaForm plugin={plugin} value={config} onChange={setConfig} />
        <button className="button primary" type="submit">Create binding</button>
      </form>
    </Drawer>
  </div>;
}
