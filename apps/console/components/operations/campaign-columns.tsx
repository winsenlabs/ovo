import type { ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { IdChip } from '../ui/section-card';
import { RelativeTime } from '../ui/display';
import type { SessionIdentity } from '../../lib/api';
import type { CampaignRecord } from '../../lib/operator-api';
import { callingHoursLabel, campaignAttemptCounts } from '../../lib/derive/operations';
import { formatDateTime } from '../../lib/format';
import { AttemptOutcomeBar } from './campaign-attempt-bar';
import type { ReleaseOption } from './agent-release-options';

/** The campaigns table's column set. Split out of `CampaignsView` purely to keep that module
 * under the size gate; each action closes over the view's own `command`/`setTestCampaign`. */
export function campaignColumns({
  role,
  busyId,
  releases,
  command,
  onTest,
}: {
  role: SessionIdentity['role'];
  busyId: string | undefined;
  releases: readonly ReleaseOption[];
  command: (campaign: CampaignRecord, action: 'pause' | 'resume' | 'cancel') => void;
  onTest: (campaign: CampaignRecord) => void;
}): ColumnV2<CampaignRecord>[] {
  const agentName = (campaign: CampaignRecord) =>
    releases.find((release) => release.id === campaign.agentReleaseId)?.agentName;
  return [
    {
      id: 'name',
      header: 'Campaign',
      cell: (campaign) => (
        <>
          <strong>{campaign.name}</strong>
          <br />
          {agentName(campaign) ?? <span className="ds-unknown">Unknown agent</span>}
          <br />
          <IdChip id={campaign.id} short={campaign.id} />
        </>
      ),
      sortValue: (campaign) => campaign.name,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (campaign) => (
        <>
          <StatusBadgeV2 value={campaign.status} />
          <br />
          <small className="muted">v{campaign.version}</small>
        </>
      ),
      sortValue: (campaign) => campaign.status,
    },
    {
      id: 'schedule',
      header: 'Schedule',
      cell: (campaign) => (
        <>
          {formatDateTime(campaign.scheduleAt)}
          <br />
          <small className="muted">
            <RelativeTime value={campaign.scheduleAt} /> · {callingHoursLabel(campaign)}
          </small>
        </>
      ),
      sortValue: (campaign) => campaign.scheduleAt,
    },
    {
      id: 'attempts',
      header: 'Attempt outcomes',
      cell: (campaign) => <AttemptOutcomeBar counts={campaignAttemptCounts(campaign.attempts)} />,
    },
    {
      id: 'limits',
      header: 'Limits',
      cell: (campaign) => (
        <small className="muted">
          {campaign.perNumberAttemptLimit}/number · {campaign.maxAttemptsPerLocalDay}/day ·{' '}
          {campaign.maxConcurrency ?? 1} concurrent
        </small>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (campaign) => (
        <div className="button-row">
          {campaign.status === 'running' && (
            <button
              className="button small"
              disabled={role === 'viewer' || busyId === campaign.id}
              onClick={() => command(campaign, 'pause')}
            >
              Pause
            </button>
          )}
          {['paused', 'scheduled'].includes(campaign.status) && (
            <button
              className="button small"
              disabled={role === 'viewer' || busyId === campaign.id}
              onClick={() => command(campaign, 'resume')}
            >
              Resume
            </button>
          )}
          <button
            className="button small"
            disabled={role === 'viewer'}
            onClick={() => onTest(campaign)}
          >
            Test with a contact
          </button>
          {!['cancelled', 'completed'].includes(campaign.status) && (
            <button
              className="button small danger"
              disabled={role === 'viewer' || busyId === campaign.id}
              onClick={() => command(campaign, 'cancel')}
            >
              Cancel
            </button>
          )}
        </div>
      ),
    },
  ];
}
