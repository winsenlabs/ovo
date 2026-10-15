// One slot's card on the agent plugins page: picker, binding and schema form, collapsed by
// default when it is optional and unset (brief §3 "Agent plugins"). Split out of
// `agent-plugins.tsx` to stay under the module-size gate.
import { Fragment } from 'react';
import type { CredentialMetadata, ProviderBinding } from '../../lib/api';
import type { AgentVoice, PluginCatalog, PluginOption, Slot } from './types';
import { SlotPicker, SLOT_LABELS, REQUIRED_SLOTS } from './slot-picker';
import { BindingSelect } from './binding-select';
import { SchemaForm } from './schema-form';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';

const OPTIONAL_COLLAPSIBLE: ReadonlySet<Slot> = new Set(['vad', 'turnDetector', 'knowledge']);

export function PluginSlotSection({
  slot,
  voice,
  mode,
  language,
  decisionConfigured,
  knowledgeConfigured,
  plugins,
  bindings,
  credentials,
  onVoiceChange,
  onBindingCreated,
  onCredentialCreated,
  onSaveSecret,
}: {
  slot: Slot;
  voice: AgentVoice;
  mode: 'announcement' | 'faq' | 'context' | 'agent';
  language: string;
  decisionConfigured: boolean;
  knowledgeConfigured: boolean;
  plugins: readonly PluginCatalog['plugins'][number][];
  bindings: readonly ProviderBinding[];
  credentials: readonly CredentialMetadata[];
  onVoiceChange: (voice: AgentVoice) => void;
  onBindingCreated: (binding: ProviderBinding) => void;
  onCredentialCreated: (credential: CredentialMetadata) => void;
  onSaveSecret: (plugin: PluginOption, pointer: string, secret: string) => Promise<void>;
}) {
  const choice = voice[slot];
  const plugin = plugins.find((item) => item.id === choice?.plugin);
  const required = REQUIRED_SLOTS.has(slot);
  const collapsible = OPTIONAL_COLLAPSIBLE.has(slot) && !choice?.plugin;
  const title = SLOT_LABELS[slot] ?? slot;
  const header = (
    <div className="ds-plugin-slot-head">
      <StatusBadgeV2 tone="neutral" size="sm" label={required ? 'Required' : 'Optional'} />
    </div>
  );
  const body = (
    <div className="ds-plugin-slot-body">
      <SlotPicker
        slot={slot}
        plugins={plugins}
        voice={voice}
        mode={mode}
        language={language}
        value={choice?.plugin}
        decisionConfigured={decisionConfigured}
        knowledgeConfigured={knowledgeConfigured}
        onChange={(pluginId) =>
          onVoiceChange({ ...voice, [slot]: { plugin: pluginId, config: {} } })
        }
      />
      {plugin && (
        <Fragment key={plugin.id}>
          <BindingSelect
            plugin={plugin}
            value={choice?.binding}
            bindings={bindings}
            credentials={credentials}
            onChange={(binding) => onVoiceChange({ ...voice, [slot]: { ...choice!, binding } })}
            onCreated={onBindingCreated}
            onCredentialCreated={onCredentialCreated}
          />
          <SchemaForm
            plugin={plugin}
            schema={plugin.configSchema}
            value={choice?.config ?? {}}
            credentials={credentials}
            onChange={(config) => onVoiceChange({ ...voice, [slot]: { ...choice!, config } })}
            onSecret={(pointer, secret) => onSaveSecret(plugin, pointer, secret)}
          />
        </Fragment>
      )}
    </div>
  );

  if (!collapsible)
    return (
      // The real anchor target: `SectionCard`'s own `id` prop only wires up its heading's
      // `aria-labelledby`, it does not set an id on the section itself (brief's "click a node to
      // jump to its slot" and the compat-issue links both need a real `#slot-x`).
      <div id={`slot-${slot}`}>
        <SectionCard id={`slot-${slot}`} title={title} actions={header}>
          {body}
        </SectionCard>
      </div>
    );
  return (
    <details id={`slot-${slot}`} className="ds-card">
      <summary className="ds-card-head" style={{ cursor: 'pointer' }}>
        <h2 style={{ display: 'inline' }}>{title}</h2> {header}
      </summary>
      <div className="ds-card-body pad-data">{body}</div>
    </details>
  );
}
