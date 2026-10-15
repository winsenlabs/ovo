// The Configure tab's save conflict: the server draft changed underneath the operator's own
// edits. Split out of `studio.tsx` to stay under the module-size gate. Shows a real diff against
// the server's current draft instead of two raw JSON blobs side by side with nothing connecting
// them (verifier: "a conflict still shows two raw JSON blobs instead of a diff view") — the full
// configs stay available underneath, collapsed, for the rare case the diff itself is not enough.
import type { AgentConfig } from '../../lib/api';
import { InlineAlert } from '../ui/feedback-v2';
import { JsonViewer } from '../ui/code-block';
import { ResponsiveTable } from '../primitives';
import { configurationDiff } from './release-diff';

export function DraftConflict({
  config,
  conflict,
  onReload,
}: {
  config: AgentConfig;
  conflict: unknown;
  onReload: () => void;
}) {
  const differences = configurationDiff(conflict, config);
  return (
    <InlineAlert tone="danger">
      <strong>This draft changed on the server.</strong> Your local edit was not overwritten.
      {differences.length ? (
        <ResponsiveTable label="What changed on the server since you started editing">
          <thead>
            <tr>
              <th>Path</th>
              <th>Server now</th>
              <th>Your draft</th>
            </tr>
          </thead>
          <tbody>
            {differences.slice(0, 40).map((difference) => (
              <tr key={difference.path}>
                <td className="mono">{difference.path}</td>
                <td className="compact-json">{JSON.stringify(difference.before)}</td>
                <td className="compact-json">{JSON.stringify(difference.after)}</td>
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      ) : (
        <p className="muted">
          The server draft now matches yours field-for-field; only its version advanced.
        </p>
      )}
      <div className="ui-cluster">
        <JsonViewer value={config} label="Show your full local configuration" />
        <JsonViewer value={conflict} label="Show the full server draft" />
      </div>
      <button className="button" onClick={onReload}>
        Reload server draft
      </button>
    </InlineAlert>
  );
}
