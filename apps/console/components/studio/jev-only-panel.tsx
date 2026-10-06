'use client';
import { agentLlmPaths } from '@winsendotai/ovo-contracts';
import type { AgentConfig } from '../../lib/api';
import { Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';

type Unavailable = NonNullable<AgentConfig['decisionUnavailable']>;

/** Plain-language names for the config paths that can reach the LLM. */
function describePath(path: string): string {
  if (path === 'decision') return 'No decision policy: every turn goes to the LLM.';
  if (path === 'decisionUnavailable')
    return 'When the decision model is unavailable, the turn falls through to the LLM.';
  if (path === 'allowedTools') return 'Approved tools are only ever called by the LLM.';
  if (path === 'recovery.exhausted.action')
    return 'Recovery hands the turn to the LLM when exhausted.';
  if (path.endsWith('.fallback')) return `Below its threshold, ${path} defers to the LLM.`;
  return `An answer with no line (${path}) lets the LLM compose the reply.`;
}

/**
 * Jev-only status (AGT-4) and the decision-unavailable line. An agent whose every path is answered
 * by a decision outcome, a rule or a recovery line needs no LLM binding, publishes without one, and
 * never pays for a model call.
 */
export function JevOnlyPanel({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const paths = agentLlmPaths(config);
  const unavailable = config.decisionUnavailable;
  const decisionEnabled = config.decision?.enabled === true;
  const setUnavailable = (next: Unavailable | undefined) =>
    update({ ...config, decisionUnavailable: next });
  return (
    <Panel labelledBy="jev-only-title">
      <PanelHeader
        id="jev-only-title"
        title="LLM use"
        badge={
          paths.length ? (
            <StatusBadge tone="soft">
              LLM on {paths.length} path{paths.length === 1 ? '' : 's'}
            </StatusBadge>
          ) : (
            <StatusBadge tone="good">Jev-only</StatusBadge>
          )
        }
      />
      <div className="panel-body stack">
        {paths.length ? (
          <>
            <p className="muted">
              This agent needs an LLM binding. To run it Jev-only, answer each of these with a line:
            </p>
            <ul>
              {paths.map((path) => (
                <li key={path}>{describePath(path)}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">
            Every turn is answered by the decision model, a rule or a recovery line. No LLM binding
            is needed; one that is selected is never asked.
          </p>
        )}
        {decisionEnabled && (
          <>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={unavailable !== undefined}
                onChange={(event) =>
                  setUnavailable(event.target.checked ? { action: 'reprompt' } : undefined)
                }
              />
              <span>
                <strong>Answer an unavailable decision model without the LLM</strong>
                <small>
                  When it times out or fails, say a line instead (the re-ask by default).
                </small>
              </span>
            </label>
            {unavailable && (
              <div className="form-grid">
                <Field label="Line when the decision is unavailable" htmlFor="unavailable-line">
                  <input
                    id="unavailable-line"
                    value={unavailable.line ?? ''}
                    onChange={(event) =>
                      setUnavailable({
                        ...unavailable,
                        line: event.target.value.trim() ? event.target.value : undefined,
                      })
                    }
                  />
                </Field>
                <Field label="Then" htmlFor="unavailable-action">
                  <select
                    id="unavailable-action"
                    value={unavailable.action}
                    onChange={(event) =>
                      setUnavailable({
                        ...unavailable,
                        action: event.target.value as Unavailable['action'],
                      })
                    }
                  >
                    <option value="reprompt">Keep listening</option>
                    <option value="end">End the call</option>
                  </select>
                </Field>
              </div>
            )}
            {unavailable?.action === 'end' && !unavailable.line && (
              <Notice tone="danger">Ending the call needs the line to end on.</Notice>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
