import type { HoldPolicy } from '../../lib/types/queues';
import { holdTimeline } from '../../lib/derive/routing-hold';

const KIND_LABEL = { clip: 'Clip', silence: 'Silence', line: 'Spoken line' } as const;

/**
 * The hold drawn on a time axis: clips, silences and lines in order, looping from the loop step,
 * cut at the longest wait where the timeout steps begin. A caption and a table say the same.
 */
export function HoldTimeline({
  policy,
  clipSeconds,
}: {
  policy: HoldPolicy;
  clipSeconds?: (assetId: string) => number | undefined;
}) {
  const { segments, maxSeconds } = holdTimeline(policy, { clipSeconds });
  const summary = `Hold timeline: ${segments.length} part${segments.length === 1 ? '' : 's'} over ${maxSeconds} seconds, then the timeout steps.`;
  return (
    <figure className="rt-hold">
      <div className="rt-hold-bar" role="img" aria-label={summary}>
        {segments.map((s, i) => (
          <span
            key={i}
            className={`rt-hold-seg kind-${s.kind}${s.loop > 0 ? ' looped' : ''}`}
            style={{ width: `${((s.toS - s.fromS) / maxSeconds) * 100}%` }}
            title={`${s.label}: ${s.fromS}s to ${s.toS}s${s.loop > 0 ? ' (repeat)' : ''}`}
          />
        ))}
        <span className="rt-hold-end" aria-hidden="true" />
      </div>
      <figcaption className="muted">
        0 s <span aria-hidden="true">→</span> {maxSeconds} s: then the timeout steps run. Hatched
        parts are repeats.
      </figcaption>
      <details>
        <summary>Show as a table</summary>
        <table className="rt-hold-table">
          <caption className="sr-only">Hold timeline as a table</caption>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">What plays</th>
              <th scope="col">Pass</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s, i) => (
              <tr key={i}>
                <td>{s.fromS} s</td>
                <td>{s.toS} s</td>
                <td>
                  {KIND_LABEL[s.kind]}
                  {s.label.includes('unknown') ? ' (length unknown)' : ''}
                </td>
                <td>{s.loop + 1}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
