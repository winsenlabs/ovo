'use client';
import { useCallback, useEffect, useState } from 'react';
import { ChangeList } from '../../../components/routing/change-list';
import { IssueList } from '../../../components/routing/issue-list';
import { Drawer } from '../../../components/ui/drawer';
import { EmptyStateV2, ErrorState, InlineAlert, Skeleton } from '../../../components/ui/feedback-v2';
import { IdChip } from '../../../components/ui/section-card';
import { ApiError } from '../../../lib/api';
import { routingApi } from '../../../lib/data/routing-api';
import type { PublishPreview } from '../../../lib/types/routing';

type State =
  | { status: 'loading' }
  | { status: 'ready'; preview: PublishPreview }
  | { status: 'error'; message: string }
  | { status: 'published'; version: number };

function Pins({ pins }: { pins: PublishPreview['pins'] }) {
  if (!pins.length) return null;
  return (
    <section aria-label="Agent releases pinned">
      <h4>Agent releases this publish pins</h4>
      <ul className="rt-pins">
        {pins.map((pin, i) => (
          <li key={i}>
            <span className="mono">{pin.agentId}</span> {pin.was === 'latest' ? 'newest, pinned to' : 'stays on'} <span className="mono">{pin.releaseId.slice(0, 8)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Publish a draft: the server previews exactly what a release would contain (blockers, warnings,
 * the digest, what changed since the last release and which agent releases it pins) before the
 * operator confirms. Unsaved edits are not published, so they must be saved first.
 */
export function PublishDrawer({
  open,
  onClose,
  pointId,
  draftVersion,
  dirty,
  onSave,
  saving,
  onPublished,
  onBindNumbers,
}: {
  open: boolean;
  onClose: () => void;
  pointId: string;
  draftVersion: number;
  dirty: boolean;
  onSave: () => Promise<boolean>;
  saving: boolean;
  onPublished: () => void;
  onBindNumbers: () => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const preview = useCallback(async () => {
    setState({ status: 'loading' });
    setProblem(undefined);
    try {
      setState({ status: 'ready', preview: await routingApi.previewPublish(pointId) });
    } catch (failure) {
      setState({ status: 'error', message: failure instanceof Error ? failure.message : 'The preview could not be loaded.' });
    }
  }, [pointId]);
  useEffect(() => {
    if (open && !dirty) void preview();
  }, [open, dirty, draftVersion, preview]);

  async function publish() {
    setBusy(true);
    setProblem(undefined);
    try {
      const release = await routingApi.publish(pointId, draftVersion);
      setState({ status: 'published', version: release.version });
      onPublished();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'routing_publish_blocked') void preview();
      else if (failure instanceof ApiError && failure.code === 'routing_point_conflict')
        setProblem('The draft changed on the server while you were reviewing. Reload the page and review again.');
      else setProblem(failure instanceof Error ? failure.message : 'The release could not be published.');
    } finally {
      setBusy(false);
    }
  }

  const ready = state.status === 'ready' ? state.preview : undefined;
  const reason = !ready ? undefined : ready.blockers.length ? `${ready.blockers.length} problem${ready.blockers.length === 1 ? '' : 's'} must be fixed first` : ready.unchanged ? `Nothing changed since v${ready.previous?.version}` : undefined;
  return (
    <Drawer open={open} title="Publish a release" onClose={onClose}>
      <div className="rt-stack rt-publish" aria-live="polite">
        {dirty && (
          <InlineAlert tone="warn">
            You have unsaved changes. A release is made from the saved draft, so save first.
            <button type="button" className="button small" disabled={saving} onClick={() => void onSave()}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </InlineAlert>
        )}
        {!dirty && state.status === 'loading' && <Skeleton shape="block" />}
        {!dirty && state.status === 'error' && <ErrorState message={state.message} onRetry={() => void preview()} />}
        {state.status === 'published' && (
          <EmptyStateV2 title={`Published version ${state.version}`} action={<button type="button" className="button primary" onClick={onBindNumbers}>Bind numbers to it</button>}>
            Numbers keep using their current release until you bind them to this one.
          </EmptyStateV2>
        )}
        {!dirty && ready && (
          <>
            <p>
              This would create <strong>version {ready.nextVersion}</strong>
              {ready.digest && (
                <>
                  {' '}with digest <IdChip id={ready.digest} short={ready.digest.slice(0, 12)} />
                </>
              )}
              .
            </p>
            {ready.unchanged && <InlineAlert tone="info">No changes since version {ready.previous?.version}: the release would be identical.</InlineAlert>}
            {ready.blockers.length > 0 && (
              <section aria-label="Blockers">
                <h4>Fix these before publishing</h4>
                <IssueList issues={ready.blockers} label="Blockers" />
              </section>
            )}
            {ready.warnings.length > 0 && (
              <section aria-label="Warnings">
                <h4>Warnings</h4>
                <IssueList issues={ready.warnings} label="Warnings" />
              </section>
            )}
            <section aria-label="What changed">
              <h4>{ready.previous ? `What changed since version ${ready.previous.version}` : 'What is new'}</h4>
              <ChangeList changes={ready.changes} empty="No changes." />
            </section>
            <Pins pins={ready.pins} />
          </>
        )}
        {problem && <InlineAlert tone="danger">{problem}</InlineAlert>}
        <div className="button-row queue-form-actions">
          <button type="button" className="button" onClick={onClose}>
            {state.status === 'published' ? 'Close' : 'Cancel'}
          </button>
          {state.status !== 'published' && (
            <button type="button" className="button primary" disabled={!ready || !ready.canPublish || ready.unchanged || busy || dirty} title={reason} onClick={() => void publish()}>
              {busy ? 'Publishing…' : 'Publish'}
            </button>
          )}
        </div>
        {reason && <p className="muted">{reason}.</p>}
      </div>
    </Drawer>
  );
}
