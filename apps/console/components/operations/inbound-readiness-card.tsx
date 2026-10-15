import { StatusBadgeV2 } from '../ui/status-badge';

/** What the dispatcher last reported about inbound go-live (OPS-4); null before it published. */
export interface InboundReadiness {
  admissionEnabled: boolean;
  readyWorkers: number;
  readyProtected: number;
  warmFloor: number;
  ready: boolean;
  reasons: string[];
  observedAt: string;
  ageMs: number;
  stale: boolean;
}
export interface Capacity {
  readyProtected: number;
  readiness?: InboundReadiness | null;
}

/** Why `readyProtected` is what it is, so readiness can be checked before go-live (OPS-4). Split
 * out of `InboundPolicy` purely to keep that module under the size gate. */
export function ReadinessCard({ readiness }: { readiness: InboundReadiness | null | undefined }) {
  if (readiness === undefined) return null;
  if (readiness === null)
    return (
      <p className="muted" role="status">
        No dispatcher has reported inbound readiness yet. Check that the dispatcher is running.
      </p>
    );
  const tone = readiness.stale ? 'warn' : readiness.ready ? 'ok' : 'warn';
  return (
    <section aria-label="Inbound readiness" className="stack">
      <div className="button-row">
        <StatusBadgeV2
          tone={tone}
          label={
            readiness.stale
              ? 'Readiness report is stale'
              : readiness.ready
                ? readiness.admissionEnabled
                  ? 'Ready for inbound calls'
                  : 'Ready to enable inbound admission'
                : 'Not ready for inbound calls'
          }
        />
        <span className="muted">
          Admission {readiness.admissionEnabled ? 'enabled' : 'disabled'} · {readiness.readyWorkers}{' '}
          ready {readiness.readyWorkers === 1 ? 'worker' : 'workers'} · warm floor{' '}
          {readiness.warmFloor} · reported {Math.round(readiness.ageMs / 1000)}s ago
        </span>
      </div>
      {readiness.stale && (
        <p className="muted">
          The dispatcher has not published readiness recently; it may be stopped.
        </p>
      )}
      {readiness.reasons.length > 0 && (
        <ul aria-label="Readiness reasons">
          {readiness.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
