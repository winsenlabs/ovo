'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest, ApiError, items, type SessionIdentity } from '../../lib/api';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { Tabs, type TabItem } from '../ui/tabs';
import { ErrorState, EmptyStateV2, SkeletonTableRows } from '../ui/feedback-v2';
import { formatPercent } from '../../lib/format';
import { CliRegistryPanel } from './cli-registry-panel';
import { ComplaintsPanel } from './complaints-panel';
import { ComplianceEvidencePanel } from './compliance-evidence-panel';
import { ComplianceOverviewTab } from './compliance-overview-tab';
import { ComplianceSettingsPanel } from './compliance-settings-panel';
import {
  failureText,
  type A2pDeclaration,
  type CliNumber,
  type CliRatio,
  type Complaint,
  type SettingsRecord,
} from './compliance-types';
import { ConsentRecordsPanel } from './consent-records-panel';

interface Loaded {
  settings: SettingsRecord;
  numbers: CliNumber[];
  declarations: A2pDeclaration[];
  ratios: CliRatio[];
  complaints: Complaint[];
}

const TABS: TabItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'numbers', label: 'Caller numbers' },
  { id: 'complaints', label: 'Complaints' },
  { id: 'consent', label: 'Consent & DND' },
  { id: 'settings', label: 'Settings' },
  { id: 'export', label: 'Export' },
];

/**
 * India outbound compliance (TRAI TCCCPR, RBI recovery): sender settings, caller numbers and A2P
 * declarations, consent and DND scrub, complaints with SLA timers, ratios and the export.
 */
export function ComplianceView({ role }: { role: SessionIdentity['role'] }) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState('overview');
  const editor = role !== 'viewer';
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const get = async <T,>(path: string) => (await apiRequest<T>(path)).data;
      const [settings, numbers, declarations, ratios, complaints] = await Promise.all([
        get<SettingsRecord>('/operations/compliance/settings'),
        get<unknown>('/operations/compliance/cli-numbers'),
        get<unknown>('/operations/compliance/a2p-declarations'),
        get<unknown>('/operations/compliance/ratios'),
        editor ? get<unknown>('/operations/compliance/complaints') : Promise.resolve([]),
      ]);
      setLoaded({
        settings,
        numbers: items(numbers),
        declarations: items(declarations),
        ratios: items(ratios),
        complaints: items(complaints),
      });
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'Operations are not configured on this installation.'
          : failureText(failure, 'Compliance settings unavailable.'),
      );
    } finally {
      setLoading(false);
    }
  }, [editor]);
  useEffect(() => {
    void load();
  }, [load]);

  const posture = useMemo(() => {
    if (!loaded) return undefined;
    const activeNumbers = loaded.numbers.filter((n) => n.status === 'active').length;
    const flagged = loaded.numbers.filter((n) => n.status === 'flagged').length;
    const suspended = loaded.numbers.filter((n) => n.status === 'suspended').length;
    const openComplaints = loaded.complaints.filter(
      (c) => c.status !== 'closed' && c.status !== 'resolved',
    ).length;
    const overdueComplaints = loaded.complaints.filter((c) => c.overdue).length;
    const worstRatio = loaded.ratios.reduce((max, row) => Math.max(max, row.abandonedRatio), 0);
    const effectiveDeclarations = loaded.declarations.filter((d) => !d.withdrawnAt).length;
    const withdrawnDeclarations = loaded.declarations.filter((d) => d.withdrawnAt).length;
    return {
      activeNumbers,
      flagged,
      suspended,
      openComplaints,
      overdueComplaints,
      worstRatio,
      effectiveDeclarations,
      withdrawnDeclarations,
    };
  }, [loaded]);

  const ratioChartData = useMemo(
    () =>
      (loaded?.ratios ?? []).map((row) => ({
        category: row.fromNumber,
        values: { abandoned: row.abandonedRatio * 100, silent: row.silentRatio * 100 },
      })),
    [loaded],
  );
  const slaQueue = useMemo(
    () =>
      (loaded?.complaints ?? [])
        .filter((c) => c.status !== 'closed')
        .sort((a, b) => Number(Boolean(b.overdue)) - Number(Boolean(a.overdue))),
    [loaded],
  );

  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Dial safety"
        title="Compliance"
        description="Every +91 call is checked against TRAI’s rules and RBI’s recovery hours before it is dialed. Settings here can only make the rules stricter."
        meta={
          loaded ? (
            <span className="muted">
              Rule pack {loaded.settings.rulePack.id}@{loaded.settings.rulePack.version} · settings
              v{loaded.settings.version}
            </span>
          ) : undefined
        }
        onRefresh={() => void load()}
        refreshing={loading}
      />
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {loaded && posture && (
        <KpiStrip>
          <KpiCard
            label="Caller numbers"
            value={`${posture.activeNumbers} active`}
            footnote={`${posture.flagged} flagged · ${posture.suspended} suspended`}
          />
          <KpiCard
            label="Open complaints"
            value={posture.openComplaints}
            footnote={`${posture.overdueComplaints} overdue`}
          />
          <KpiCard
            label="Worst abandoned ratio"
            value={
              // A plain number here reads as fine either side of the breaker; colour it the
              // moment it crosses 3% so the KPI itself carries the warning, not just the chart.
              posture.worstRatio >= 0.03 ? (
                <span className="danger-text">{formatPercent(posture.worstRatio)}</span>
              ) : (
                formatPercent(posture.worstRatio)
              )
            }
            footnote="3% breaker"
          />
          <KpiCard
            label="A2P declarations"
            value={`${posture.effectiveDeclarations} effective`}
            footnote={`${posture.withdrawnDeclarations} withdrawn`}
          />
        </KpiStrip>
      )}
      <SectionCard padding="flush">
        <Tabs items={TABS} current={tab} onSelect={setTab} panelId="compliance-tab-panel" />
        <div id="compliance-tab-panel" className="ds-card-body pad-data">
          {!loaded && !error && <SkeletonTableRows rows={6} columns={4} />}
          {loaded && tab === 'overview' && (
            <ComplianceOverviewTab
              ratioChartData={ratioChartData}
              ratios={loaded.ratios}
              slaQueue={slaQueue}
              settings={loaded.settings}
            />
          )}
          {loaded && tab === 'numbers' && (
            <CliRegistryPanel
              numbers={loaded.numbers}
              declarations={loaded.declarations}
              canEdit={role === 'admin'}
              onChanged={load}
            />
          )}
          {loaded &&
            tab === 'complaints' &&
            (editor ? (
              <ComplaintsPanel complaints={loaded.complaints} canEdit={editor} onChanged={load} />
            ) : (
              <EmptyStateV2 title="Viewers cannot see complaints" />
            ))}
          {loaded &&
            tab === 'consent' &&
            (editor ? (
              <ConsentRecordsPanel canEdit={editor} />
            ) : (
              <EmptyStateV2 title="Viewers cannot manage consent" />
            ))}
          {loaded && tab === 'settings' && (
            <ComplianceSettingsPanel
              record={loaded.settings}
              canEdit={role === 'admin'}
              onSaved={load}
            />
          )}
          {loaded && tab === 'export' && (
            <ComplianceEvidencePanel ratios={loaded.ratios} canExport={role === 'admin'} />
          )}
        </div>
      </SectionCard>
    </div>
  );
}
