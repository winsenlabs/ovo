'use client';
import { useRef } from 'react';
import type { AgentVoice, CompatIssue } from './types';
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
    <section className="panel-body" aria-labelledby="compat-title">
      <h2 ref={heading} id="compat-title" tabIndex={-1}>
        Compatibility
      </h2>
      <div className="ui-stack">
        {[...groups].map(([group, entries]) => (
          <div key={group}>
            <h3>{group}</h3>
            <ul>
              {entries.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  <a
                    href={issue.slot ? `#slot-${issue.slot}` : '#compat-title'}
                    onClick={() => heading.current?.focus()}
                  >
                    {issue.message}
                  </a>
                  <span className={`badge ${issue.severity === 'error' ? 'danger' : 'warning'}`}>
                    {issue.severity}
                  </span>
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
    </section>
  );
}
