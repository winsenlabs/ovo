'use client';
import { InlineAlert } from '../../components/ui/feedback-v2';
import { StatusBadgeV2 } from '../../components/ui/status-badge';
import { humaniseEnum } from '../../lib/status';
import type { WebhookTestResult } from '../../lib/types/queues';

export interface TestState {
  status: 'idle' | 'running' | 'done' | 'error';
  result?: WebhookTestResult;
  message?: string;
}

/** The outcome of "Send test webhook": each attempt, then what the third party answered. */
export function TestWebhookResult({ test }: { test: TestState }) {
  if (test.status === 'idle') return null;
  if (test.status === 'running') return <p className="muted" role="status">Sending a test request…</p>;
  if (test.status === 'error') return <InlineAlert tone="danger">{test.message}</InlineAlert>;
  const { result } = test;
  if (!result) return null;
  return (
    <div className="queue-test" role="status">
      <h4>Test result</h4>
      <p className="muted">
        A synthetic call (caller +15550100) was sent to {result.request.url}. No ticket was created
        and no real caller was involved. Secrets are not shown.
      </p>
      <ol className="queue-attempts">
        {result.attempts.map((attempt) => (
          <li key={attempt.attempt}>
            Attempt {attempt.attempt}{' '}
            <StatusBadgeV2
              tone={attempt.outcome === 'delivered' ? 'ok' : attempt.outcome === 'retry' ? 'warn' : 'danger'}
              label={humaniseEnum(attempt.outcome)}
            />{' '}
            {attempt.status !== undefined && <span className="mono">HTTP {attempt.status}</span>}{' '}
            <span className="mono">{attempt.ms} ms</span>
            {attempt.reason && <span className="muted"> ({attempt.reason})</span>}
          </li>
        ))}
      </ol>
      {result.failure && (
        <InlineAlert tone="danger">Delivery failed: {humaniseEnum(result.failure)}.</InlineAlert>
      )}
      {result.answer && (
        <p>
          Answer: <strong>{humaniseEnum(result.answer.kind)}</strong>
          {result.answer.reason && ` (${result.answer.reason})`}
          {result.answer.destination && (
            <code className="mono"> {JSON.stringify(result.answer.destination)}</code>
          )}
          {result.answer.destinationCheck && (
            <>
              {' '}
              <StatusBadgeV2
                tone={result.answer.destinationCheck === 'allowed' ? 'ok' : 'danger'}
                label={
                  result.answer.destinationCheck === 'allowed'
                    ? 'Inside the allow-list'
                    : 'Outside the allow-list, would not be dialled'
                }
              />
            </>
          )}
        </p>
      )}
      <details>
        <summary>Request sent</summary>
        <pre className="mono ds-code-pre" tabIndex={0}>
          {JSON.stringify({ headers: result.request.headers, body: result.request.body }, null, 2)}
        </pre>
      </details>
    </div>
  );
}
