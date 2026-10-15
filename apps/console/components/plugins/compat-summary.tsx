'use client';
import { useRef } from 'react';
import { StatusBadgeV2 } from '../ui/status-badge';
import type { AgentVoice, CompatIssue } from './types';

/** The compat status badge alone, for the summary bar at the top of the plugins page. */
export function CompatStatusBadge({ issues }: { issues: readonly CompatIssue[] }) {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  if (!issues.length) return <StatusBadgeV2 tone="ok" label="OK" />;
  return (
    <StatusBadgeV2
      tone={errors > 0 ? 'danger' : 'warn'}
      label={`${issues.length} issue${issues.length === 1 ? '' : 's'}`}
    />
  );
}

export function CompatSummary({
  issues,
  voice,
  onChange,
}: {
  issues: readonly CompatIssue[];
  voice: AgentVoice;
  onChange: (voice: AgentVoice) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  if (!issues.length) return <p role="status">No compatibility issues reported.</p>;
  const groups = Map.groupBy(issues, (issue) => `${issue.stage} · ${issue.slot ?? 'general'}`);
  const needsAcknowledgement = issues.some(
    (issue) => issue.code === 'playback_evidence_insufficient',
  );
  const accepted = voice.acknowledgements?.includes('weak-playback-evidence') ?? false;
  return (
    <div aria-labelledby="compat-title">
      <h2 ref={heading} id="compat-title" tabIndex={-1}>
        Compatibility
      </h2>
      <div className="ui-stack">
        {[...groups].map(([group, entries]) => (
          <div key={group}>
            <h3>{group}</h3>
            <ul className="plain-list">
              {entries.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  <a
                    href={issue.slot ? `#slot-${issue.slot}` : '#compat-title'}
                    onClick={() => heading.current?.focus()}
                  >
                    {issue.message}
                  </a>
                  <StatusBadgeV2
                    tone={issue.severity === 'error' ? 'danger' : 'warn'}
                    size="sm"
                    label={issue.severity}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {needsAcknowledgement && (
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) =>
              onChange({
                ...voice,
                acknowledgements: event.target.checked
                  ? [...new Set([...voice.acknowledgements, 'weak-playback-evidence' as const])]
                  : voice.acknowledgements.filter((value) => value !== 'weak-playback-evidence'),
              })
            }
          />
          I accept weaker playback evidence for this carrier
        </label>
      )}
    </div>
  );
}
