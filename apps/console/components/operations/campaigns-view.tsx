'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError, items, type SessionIdentity } from '../../lib/api';
import type { CampaignRecord } from '../../lib/operator-api';
import {
  EmptyState,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import { CampaignCreateForm } from './campaign-create-form';

export function CampaignsView({ role }: { role: SessionIdentity['role'] }) {
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const load = useCallback(async () => {
    try {
      setCampaigns(
        items<CampaignRecord>((await apiRequest<unknown>('/operations/campaigns?limit=100')).data),
      );
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'Campaign operations are not configured on this installation.'
          : failure instanceof Error
            ? failure.message
            : 'Campaigns unavailable.',
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
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
  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Outbound operations</p>
          <h1>Campaigns</h1>
          <p className="muted">
            Validated contacts, explicit local schedules, immutable releases and persisted attempt
            limits.
          </p>
        </div>
        <button className="button" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      {error && (
        <Notice tone="warning" live>
          {error}
        </Notice>
      )}
      <Panel labelledBy="campaign-create-title">
        <PanelHeader
          id="campaign-create-title"
          title="Create campaign"
          badge={
            <StatusBadge tone={role === 'viewer' ? 'warning' : 'soft'}>
              {role === 'viewer' ? 'Read only' : 'Editor flow'}
            </StatusBadge>
          }
        />
        <div className="panel-body">
          {role === 'viewer' ? (
            <Notice tone="warning">
              Editors can preview CSV contacts and create scheduled campaigns.
            </Notice>
          ) : (
            <CampaignCreateForm
              onCreated={(campaign) => setCampaigns((current) => [campaign, ...current])}
            />
          )}
        </div>
      </Panel>
      <Panel labelledBy="campaign-list-title">
        <PanelHeader
          id="campaign-list-title"
          title="Persisted campaigns"
          badge={<StatusBadge>{campaigns.length}</StatusBadge>}
        />
        {!campaigns.length ? (
          <div className="panel-body">
            <EmptyState title="No campaigns returned">
              No synthetic campaign or counters were inserted.
            </EmptyState>
          </div>
        ) : (
          <ResponsiveTable label="Campaigns">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Release</th>
                <th>Schedule</th>
                <th>Limits</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td>
                    <strong>{campaign.name}</strong>
                    <small className="mono">{campaign.id}</small>
                  </td>
                  <td className="mono">{campaign.agentReleaseId}</td>
                  <td>
                    {new Date(campaign.scheduleAt).toLocaleString()}
                    <small>{campaign.timezone}</small>
                  </td>
                  <td>
                    {campaign.maxAttemptsTotal} total
                    <small>
                      {campaign.perNumberAttemptLimit}/number · {campaign.maxAttemptsPerLocalDay}
                      /day
                    </small>
                  </td>
                  <td>
                    <StatusBadge
                      tone={
                        campaign.status === 'running'
                          ? 'good'
                          : campaign.status === 'cancelled'
                            ? 'danger'
                            : 'soft'
                      }
                    >
                      {campaign.status}
                    </StatusBadge>
                    <small>v{campaign.version}</small>
                  </td>
                  <td>
                    <div className="button-row">
                      {campaign.status === 'running' && (
                        <button
                          className="button small"
                          disabled={role === 'viewer' || busyId === campaign.id}
                          onClick={() => void command(campaign, 'pause')}
                        >
                          Pause
                        </button>
                      )}
                      {['paused', 'scheduled'].includes(campaign.status) && (
                        <button
                          className="button small"
                          disabled={role === 'viewer' || busyId === campaign.id}
                          onClick={() => void command(campaign, 'resume')}
                        >
                          Resume
                        </button>
                      )}
                      {!['cancelled', 'completed'].includes(campaign.status) && (
                        <button
                          className="button small danger"
                          disabled={role === 'viewer' || busyId === campaign.id}
                          onClick={() => void command(campaign, 'cancel')}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      </Panel>
    </div>
  );
}
