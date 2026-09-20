import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import { EmptyState, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
export function UnimplementedEvidence({
  view,
  extensions,
}: {
  view: string;
  extensions: readonly ConsoleExtension[];
}) {
  const panel = extensions
    .flatMap((extension) => extension.panels)
    .find((item) => item.id === view);
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>{panel?.title ?? view}</h1>
          <p className="muted">
            This surface reports capability state without placeholder metrics.
          </p>
        </div>
      </header>
      <Panel labelledBy="unavailable-title">
        <PanelHeader
          id="unavailable-title"
          title={`${panel?.title ?? view} data unavailable`}
          badge={<StatusBadge tone="warning">Not implemented</StatusBadge>}
        />
        <div className="panel-body">
          <EmptyState title="No management API contract">
            {panel?.description ?? 'The current backend contract does not expose this evidence.'}
          </EmptyState>
          <Notice tone="warning">
            No percentiles, worker counts, queue depth, quota state, recording status, or costs are
            inferred from other endpoints.
          </Notice>
        </div>
      </Panel>
    </>
  );
}
