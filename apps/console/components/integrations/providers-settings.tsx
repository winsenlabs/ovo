'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiRequest,
  type AgentDraft,
  type CredentialMetadata,
  type ProviderBinding,
  type SessionIdentity,
} from '../../lib/api';
import type { PluginOption } from '../plugins/types';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { Tabs } from '../ui/tabs';
import { CredentialsPanel } from './credentials-panel';
import { BindingManager } from './bindings';
import { countByEnvironment, countByStatus, isExpiringSoon } from './credential-helpers';
import { humaniseEnum } from '../../lib/status';
import { loadNormalizedAgents, settleList, type Loaded } from './settings-data';

export function ProvidersSettings({ identity }: { identity: SessionIdentity }) {
  const [tab, setTab] = useState<'credentials' | 'bindings'>('credentials');
  const [credentials, setCredentials] = useState<Loaded<CredentialMetadata[]>>({
    status: 'loading',
    data: [],
  });
  const [bindings, setBindings] = useState<Loaded<ProviderBinding[]>>({
    status: 'loading',
    data: [],
  });
  const [plugins, setPlugins] = useState<PluginOption[]>([]);
  const [agents, setAgents] = useState<AgentDraft[]>([]);
  const loaded = useRef(false);

  const reload = useCallback(async () => {
    if (!loaded.current) {
      setCredentials((current) => ({ ...current, status: 'loading' }));
      setBindings((current) => ({ ...current, status: 'loading' }));
    }
    const [credentialResult, bindingResult, pluginResult, agentResult] = await Promise.allSettled([
      apiRequest<unknown>('/credentials'),
      apiRequest<unknown>('/provider-bindings'),
      apiRequest<{ plugins: PluginOption[] }>('/plugins'),
      loadNormalizedAgents(),
    ]);
    setCredentials(settleList(credentialResult, 'Credentials unavailable.', { allow403: true }));
    setBindings(settleList(bindingResult, 'Provider bindings unavailable.'));
    if (pluginResult.status === 'fulfilled') setPlugins(pluginResult.value.data.plugins ?? []);
    if (agentResult.status === 'fulfilled') setAgents(agentResult.value);
    loaded.current = true;
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const credentialPlugins = plugins.filter((plugin) =>
    ['carrier', 'stt', 'tts', 'llm', 'decision', 'tool'].includes(plugin.kind),
  );

  const statusCounts = countByStatus(credentials.data);
  const expiring = credentials.data.filter((credential) =>
    isExpiringSoon(credential.expiresAt),
  ).length;
  const environments = countByEnvironment(bindings.data);
  const credentialsLoading = credentials.status === 'loading';
  // A 503 means the count is unknown, not zero — "0 active credentials" would read as a real
  // (alarming) fact rather than "we couldn't ask".
  const credentialsDown = credentials.status === 'error';
  const bindingsDown = bindings.status === 'error';

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Providers & secrets"
        description="Credentials stay server-side and are never returned in full. Bindings pair non-secret configuration with a stored credential reference."
      />
      <KpiStrip>
        <KpiCard
          label="Active credentials"
          value={credentialsDown ? null : (statusCounts.get('active') ?? 0)}
          loading={credentialsLoading}
        />
        <KpiCard
          label="Retired credentials"
          value={credentialsDown ? null : (statusCounts.get('retired') ?? 0)}
          loading={credentialsLoading}
        />
        <KpiCard
          label="Expiring soon"
          value={credentialsDown ? null : expiring}
          unit="≤14 days"
          delta={
            !credentialsDown && expiring > 0
              ? { value: expiring, tone: 'danger', label: 'needs rotation' }
              : undefined
          }
          loading={credentialsLoading}
        />
        {bindings.status === 'loading' ? (
          <KpiCard label="Bindings" loading />
        ) : bindingsDown ? (
          <KpiCard label="Bindings" value={null} />
        ) : environments.length ? (
          environments.map((entry) => (
            <KpiCard
              key={entry.environment}
              label={`Bindings · ${humaniseEnum(entry.environment)}`}
              value={entry.count}
            />
          ))
        ) : (
          <KpiCard label="Bindings" value={0} />
        )}
      </KpiStrip>
      <Tabs
        items={[
          { id: 'credentials', label: 'Credentials' },
          { id: 'bindings', label: 'Bindings' },
        ]}
        current={tab}
        onSelect={(id) => setTab(id as 'credentials' | 'bindings')}
        panelId="providers-tab-panel"
      />
      <div
        id="providers-tab-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="stack"
      >
        {tab === 'credentials' ? (
          <CredentialsPanel
            credentials={credentials}
            bindings={bindings.data}
            plugins={credentialPlugins}
            agents={agents}
            role={identity.role}
            reload={reload}
          />
        ) : (
          <BindingManager
            bindings={bindings.data}
            bindingsStatus={bindings.status}
            bindingsError={bindings.error}
            credentials={credentials.data}
            reload={reload}
            role={identity.role}
          />
        )}
      </div>
    </>
  );
}
