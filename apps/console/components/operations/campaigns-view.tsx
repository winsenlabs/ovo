'use client';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import type { CampaignRecord } from '../../lib/operator-api';
import { useApiList } from '../../lib/data/use-list';
import { callingHoursLabel, campaignAttemptLabel } from '../../lib/derive/operations';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { DataTableV2 } from '../ui/data-table-v2';
import { Drawer } from '../ui/drawer';
import { ErrorState } from '../ui/feedback-v2';
import { RelativeTime } from '../ui/display';
import { campaignColumns } from './campaign-columns';
import { CampaignCreateForm } from './campaign-create-form';
import { TestCallPanel } from './test-call-panel';
import { loadAgentReleaseOptions, type ReleaseOption } from './agent-release-options';

export { campaignAttemptLabel, callingHoursLabel };

export function CampaignsView({ role }: { role: SessionIdentity['role'] }) {
  const {
    rows: campaigns,
    setRows: setCampaigns,
    loading,
    error,
    setError,
    reload: load,
  } = useApiList<CampaignRecord>('/operations/campaigns?limit=100', {
    unavailableMessage: 'Campaign operations are not configured on this installation.',
    fallbackMessage: 'Campaigns unavailable.',
  });
  const [busyId, setBusyId] = useState<string>();
  const [drawer, setDrawer] = useState<'new' | null>(null);
  const [testCampaign, setTestCampaign] = useState<CampaignRecord>();
  const [releases, setReleases] = useState<ReleaseOption[]>([]);
  useEffect(() => {
    // Best-effort: the agent name is a label enhancement, not something a failed lookup should
    // block the campaigns list on.
    void loadAgentReleaseOptions()
      .then(setReleases)
      .catch(() => undefined);
  }, []);

  async function command(campaign: CampaignRecord, action: 'pause' | 'resume' | 'cancel') {
    setBusyId(campaign.id);
    setError(undefined);
    try {
      await apiRequest(`/operations/campaigns/${campaign.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ expectedVersion: campaign.version }),
      });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Campaign state could not be changed.');
    } finally {
      setBusyId(undefined);
    }
  }

  const kpis = useMemo(() => {
    const running = campaigns.filter((c) => c.status === 'running').length;
    const scheduled = campaigns.filter((c) => c.status === 'scheduled');
    const paused = campaigns.filter((c) => c.status === 'paused').length;
    const now = Date.now();
    const completed30d = campaigns.filter(
      (c) => c.status === 'completed' && now - Date.parse(c.scheduleAt) < 30 * 86_400_000,
    ).length;
    const nextScheduled = scheduled
      .slice()
      .sort((a, b) => Date.parse(a.scheduleAt) - Date.parse(b.scheduleAt))[0];
    return { running, scheduled: scheduled.length, paused, completed30d, nextScheduled };
  }, [campaigns]);

  const columns = useMemo(
    () =>
      campaignColumns({
        role,
        busyId,
        releases,
        command: (campaign, action) => void command(campaign, action),
        onTest: setTestCampaign,
      }),
    [role, busyId, releases],
  );

  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Outbound"
        title="Campaigns"
        description="Validated contacts, explicit local schedules, immutable releases and persisted attempt limits."
        actions={
          <button
            className="button primary"
            type="button"
            onClick={() => setDrawer('new')}
            disabled={role === 'viewer'}
          >
            New campaign
          </button>
        }
        onRefresh={() => void load()}
        refreshing={loading}
      />
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!(error && campaigns.length === 0 && !loading) && (
        <>
          <KpiStrip>
            <KpiCard label="Running" value={loading ? undefined : kpis.running} loading={loading} />
            <KpiCard
              label="Scheduled"
              value={loading ? undefined : kpis.scheduled}
              loading={loading}
              footnote={
                kpis.nextScheduled ? (
                  <RelativeTime value={kpis.nextScheduled.scheduleAt} />
                ) : undefined
              }
            />
            <KpiCard label="Paused" value={loading ? undefined : kpis.paused} loading={loading} />
            <KpiCard
              label="Completed, 30d"
              value={loading ? undefined : kpis.completed30d}
              loading={loading}
            />
          </KpiStrip>
          <SectionCard
            title="Campaigns"
            padding="flush"
            description={loading ? undefined : `${campaigns.length} persisted`}
          >
            <DataTableV2
              // See data-table-v2.tsx / inbound-routes-table.tsx: loading needs its own key too,
              // not just empty vs. populated, or reloading a populated table crashes.
              key={loading ? 'loading' : campaigns.length === 0 ? 'empty' : 'data'}
              label="Campaigns"
              rows={campaigns}
              columns={columns}
              rowKey={(campaign) => campaign.id}
              loading={loading}
              empty="No campaigns returned"
            />
          </SectionCard>
        </>
      )}
      <Drawer open={drawer === 'new'} onClose={() => setDrawer(null)} title="New campaign">
        <CampaignCreateForm
          onCreated={(campaign) => {
            setCampaigns((current) => [campaign, ...current]);
            setDrawer(null);
          }}
        />
      </Drawer>
      <Drawer
        open={testCampaign !== undefined}
        onClose={() => setTestCampaign(undefined)}
        title="Test with a contact"
      >
        {testCampaign && role !== 'viewer' && (
          <TestCallPanel role={role} campaigns={campaigns} initialCampaignId={testCampaign.id} />
        )}
      </Drawer>
    </div>
  );
}
