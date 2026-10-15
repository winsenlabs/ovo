'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Drawer } from '../../components/ui/drawer';
import { InlineAlert } from '../../components/ui/feedback-v2';
import { ApiError, items } from '../../lib/api';
import { apiRequest } from '../../lib/api';
import { queuesApi } from '../../lib/data/queues-api';
import { blankQueue, kindLabel, setIn } from '../../lib/derive/queues';
import type { QueueDefinition, QueueIssue, QueueRecord } from '../../lib/types/queues';
import { CommonFields } from './common-fields';
import { ContextFields } from './context-fields';
import { DeskFields } from './desk-fields';
import { DestinationFields } from './destination-fields';
import type { AudioOption } from './hold-steps';
import { MappingEditor } from './mapping-editor';
import { ResponseFields } from './response-fields';
import { RetryFields } from './retry-fields';
import { TestWebhookResult, type TestState } from './test-webhook';
import { WebhookFields, type CredentialOption } from './webhook-fields';

function issuesFrom(failure: unknown): QueueIssue[] | undefined {
  if (!(failure instanceof ApiError)) return undefined;
  const issues = failure.details?.issues;
  return Array.isArray(issues) ? (issues as QueueIssue[]) : undefined;
}

/** Create or edit a queue: common fields, then the webhook or operator-desk specifics. */
export function QueueDrawer({
  open,
  record,
  kind,
  canTest,
  onClose,
  onSaved,
}: {
  open: boolean;
  record?: QueueRecord;
  kind: QueueDefinition['kind'];
  canTest: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<QueueDefinition>(() => blankQueue(kind));
  const [issues, setIssues] = useState<QueueIssue[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [credentials, setCredentials] = useState<CredentialOption[]>([]);
  const [audio, setAudio] = useState<AudioOption[]>([]);

  useEffect(() => {
    if (!open) return;
    setDraft(record ? structuredClone(record.definition) : blankQueue(kind));
    setIssues([]);
    setError(undefined);
    setTest({ status: 'idle' });
  }, [open, record, kind]);

  useEffect(() => {
    if (!open || draft.kind !== 'external') return;
    void queuesApi.credentials().then(
      (rows) => setCredentials(rows.map((row) => ({ value: row.id, label: row.label }))),
      () => setCredentials([]),
    );
  }, [open, draft.kind]);

  useEffect(() => {
    if (!open) return;
    void apiRequest<unknown>('/routing/audio?limit=100').then(
      ({ data }) =>
        setAudio(
          items<{ id: string; name: string }>(data).map((row) => ({
            value: row.id,
            label: row.name,
          })),
        ),
      () => setAudio([]),
    );
  }, [open]);

  const patch = (path: string, value: unknown) =>
    setDraft((current) => setIn(current, path, value));
  const errors = Object.fromEntries(issues.map((issue) => [issue.path.join('.'), issue.message]));

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setIssues([]);
    try {
      if (record) await queuesApi.update(record.id, draft, record.version);
      else await queuesApi.create(draft);
      onSaved();
    } catch (failure) {
      const found = issuesFrom(failure);
      if (found) setIssues(found);
      if (failure instanceof ApiError && failure.code === 'queue_name_taken')
        setIssues([{ path: ['name'], message: 'Another queue already has this name.' }]);
      else if (failure instanceof ApiError && failure.status === 409)
        setError(
          'Someone else changed this queue. Close this panel and open it again to see their changes.',
        );
      else if (!found)
        setError(failure instanceof Error ? failure.message : 'The queue could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (!record) return;
    setTest({ status: 'running' });
    try {
      setTest({ status: 'done', result: await queuesApi.testWebhook(record.id) });
    } catch (failure) {
      setTest({
        status: 'error',
        message:
          failure instanceof ApiError && failure.code === 'webhook_disabled'
            ? 'Outbound webhooks are switched off on this installation.'
            : failure instanceof Error
              ? failure.message
              : 'The test failed.',
      });
    }
  }

  const title = record
    ? `Edit ${record.definition.name}`
    : `New ${kindLabel(kind).toLowerCase()} queue`;
  return (
    <Drawer open={open} title={title} onClose={onClose}>
      <form className="queue-form" onSubmit={save} noValidate>
        {issues.length > 0 && (
          <InlineAlert tone="danger">
            {issues.length} {issues.length === 1 ? 'problem' : 'problems'} to fix:{' '}
            {issues
              .map((issue) => `${issue.path.join('.') || 'queue'}: ${issue.message}`)
              .join('; ')}
          </InlineAlert>
        )}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        <CommonFields
          draft={draft}
          patch={patch}
          errors={errors}
          audio={audio}
          creating={!record}
        />
        {draft.kind === 'external' ? (
          <>
            <WebhookFields
              spec={draft.webhook}
              credentials={credentials}
              errors={errors}
              onChange={(spec) => patch('webhook', spec)}
            />
            <MappingEditor
              spec={draft.webhook}
              policy={draft.context}
              onChange={(spec) => patch('webhook', spec)}
            />
            <ResponseFields
              value={draft.webhook.response}
              errors={errors}
              onChange={(value) => patch('webhook.response', value)}
            />
            <DestinationFields
              value={draft.destination}
              errors={errors}
              onChange={(value) => patch('destination', value)}
            />
            <RetryFields
              spec={draft.webhook}
              callbackWindowHours={draft.callbackWindowHours}
              errors={errors}
              onChange={(spec) => patch('webhook', spec)}
              onWindow={(hours) => patch('callbackWindowHours', hours)}
            />
          </>
        ) : (
          <DeskFields draft={draft} patch={patch} errors={errors} />
        )}
        <ContextFields
          value={draft.context}
          kind={draft.kind}
          onChange={(value) => patch('context', value)}
        />
        {record && draft.kind === 'external' && canTest && (
          <div className="queue-test-box">
            <button
              type="button"
              className="button"
              onClick={() => void sendTest()}
              disabled={test.status === 'running'}
            >
              Send test webhook
            </button>
            <small className="muted"> Tests the saved version with a synthetic call.</small>
            <TestWebhookResult test={test} />
          </div>
        )}
        <div className="button-row queue-form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'Saving…' : record ? 'Save changes' : 'Create queue'}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
