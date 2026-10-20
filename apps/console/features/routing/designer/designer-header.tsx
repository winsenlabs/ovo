'use client';
import { routingPoolIds } from '@winsendotai/ovo-contracts';
import { KpiCard, KpiStrip } from '../../../components/ui/kpi';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import type { IssueIndex } from '../../../lib/derive/routing-anchor';
import type { NumberRow, ReleaseSummary, RoutingPointDraft } from '../../../lib/types/routing';

/** Draft, published and unsaved badges for the page header. */
export function DesignerBadges({ version, latest, dirty, index, validating }: { version: number; latest?: ReleaseSummary; dirty: boolean; index: IssueIndex | undefined; validating: boolean }) {
  return (
    <span className="rt-badges">
      <StatusBadgeV2 tone="neutral" label={`Draft v${version}`} />
      {latest ? <StatusBadgeV2 tone={latest.draftVersion === version ? 'ok' : 'neutral'} label={`Published v${latest.version}`} /> : <StatusBadgeV2 tone="warn" label="Never published" />}
      {dirty && <StatusBadgeV2 tone="warn" label="Unsaved changes" />}
      {index && index.errors > 0 && <StatusBadgeV2 tone="danger" label={`${index.errors} error${index.errors === 1 ? '' : 's'}`} />}
      {index && index.warnings > 0 && <StatusBadgeV2 tone="warn" label={`${index.warnings} warning${index.warnings === 1 ? '' : 's'}`} />}
      {validating && <span className="muted" role="status">Checking…</span>}
    </span>
  );
}

export function DesignerKpis({ draft, index, numbers }: { draft: RoutingPointDraft; index: IssueIndex | undefined; numbers: readonly NumberRow[] | undefined }) {
  return (
    <KpiStrip>
      <KpiCard label="Questions" value={draft.nodes.length} />
      <KpiCard label="Pools used" value={routingPoolIds(draft).length} />
      <KpiCard label="Languages" value={draft.language.allowed.length} footnote={`Default ${draft.language.default}`} />
      <KpiCard label="Issues" value={index ? index.errors + index.warnings : null} footnote={index ? `${index.errors} error${index.errors === 1 ? '' : 's'}, ${index.warnings} warning${index.warnings === 1 ? '' : 's'}` : undefined} />
      <KpiCard label="Numbers live" value={numbers ? numbers.filter((n) => n.enabled).length : null} footnote={numbers ? undefined : 'Numbers could not be read'} />
    </KpiStrip>
  );
}
