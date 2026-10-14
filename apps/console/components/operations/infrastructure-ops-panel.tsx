import type { InfrastructureSnapshot } from '../../lib/operator-api';
import { formatDateTime } from '../../lib/format';
import { KeyValueGrid, SectionCard } from '../ui/section-card';
import { ProgressMeter } from '../charts/meter';
import { EmptyStateV2 } from '../ui/feedback-v2';
import styles from './insights-grid.module.css';

function gib(bytes: number | null): string {
  return bytes == null ? 'Unknown' : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

/** Process health (CPU/memory/event-loop as meters), plus recording and telemetry ops as
 * KeyValueGrids with inner padding (brief defect #17 — labels flush to the card edge). */
export function InfrastructureOpsPanel({ snapshot }: { snapshot: InfrastructureSnapshot }) {
  const { process, recordings, telemetry } = snapshot;
  const memoryRatio =
    process.memoryRssBytesTotal != null && process.memoryLimitBytesTotal
      ? process.memoryRssBytesTotal / process.memoryLimitBytesTotal
      : null;
  return (
    <div className={styles.twoColumn}>
      <SectionCard
        title="Worker process"
        description={`${snapshot.workers.sampledWorkers ?? 0} sampled${snapshot.workers.samplesTruncated ? ' · truncated' : ''}`}
      >
        <div className="ds-stack">
          <ProgressMeter
            label="CPU, average"
            value={process.cpuPercentAverage ?? 0}
            max={100}
            tone={(process.cpuPercentAverage ?? 0) > 85 ? 'danger' : 'ok'}
            valueLabel={
              process.cpuPercentAverage == null
                ? 'Unknown'
                : `${process.cpuPercentAverage.toFixed(1)}%`
            }
          />
          <ProgressMeter
            label="Memory, RSS total"
            value={process.memoryRssBytesTotal ?? 0}
            max={process.memoryLimitBytesTotal ?? Math.max(1, process.memoryRssBytesTotal ?? 1)}
            tone={memoryRatio != null && memoryRatio > 0.9 ? 'danger' : 'ok'}
            valueLabel={`${gib(process.memoryRssBytesTotal)} of ${gib(process.memoryLimitBytesTotal)}`}
          />
          <KeyValueGrid
            columns={2}
            items={[
              {
                label: 'Event-loop lag, max',
                value: process.eventLoopLagMsMax == null ? null : `${process.eventLoopLagMsMax} ms`,
              },
              { label: 'Restarts', value: process.restartsTotal },
            ]}
          />
        </div>
      </SectionCard>
      <div className="ds-stack">
        <SectionCard title="Recording operations">
          {!recordings ? (
            <EmptyStateV2 variant="unavailable" title="Unknown">
              Recording lifecycle metrics are unknown.
            </EmptyStateV2>
          ) : (
            <KeyValueGrid
              columns={2}
              items={[
                { label: 'Queued exports', value: recordings.queuedExports },
                { label: 'Running exports', value: recordings.runningExports },
                { label: 'Pending deletion', value: recordings.pendingDeletion },
                { label: 'Failed deletion', value: recordings.failedDeletion },
                { label: 'Finalizing artifacts', value: recordings.finalizingArtifacts },
                { label: 'Failed artifacts', value: recordings.failedArtifacts },
              ]}
            />
          )}
        </SectionCard>
        <SectionCard title="Telemetry ingestion">
          {!telemetry ? (
            <EmptyStateV2 variant="unavailable" title="Unknown">
              Telemetry metrics are unknown.
            </EmptyStateV2>
          ) : (
            <KeyValueGrid
              columns={2}
              items={[
                { label: 'Events · 5 min', value: telemetry.eventsLastFiveMinutes },
                { label: 'Active calls', value: telemetry.activeCalls },
                {
                  label: 'Newest event',
                  value: telemetry.newestEventAt ? formatDateTime(telemetry.newestEventAt) : null,
                },
              ]}
            />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
