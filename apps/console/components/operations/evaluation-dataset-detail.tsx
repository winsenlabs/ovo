import type {
  EvaluationCase,
  EvaluationDataset,
  EvaluationDatasetVersion,
} from '../../lib/operator-api';
import type { SessionIdentity } from '../../lib/api';
import { SectionCard } from '../ui/section-card';
import { Select } from '../ui/inputs';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { Button } from '../ui/button';
import { EvaluationCasesTable } from './evaluation-cases-table';

/** The selected dataset's version picker, actions and cases table, extracted so
 * `EvaluationDatasetPanel` stays under the module-size gate. */
export function EvaluationDatasetDetail({
  dataset,
  versions,
  selectedVersion,
  onVersionChange,
  cases,
  role,
  busy,
  onImport,
  onArchive,
  onEditMetadata,
}: {
  dataset: EvaluationDataset;
  versions: readonly EvaluationDatasetVersion[];
  selectedVersion: number | undefined;
  onVersionChange: (version: number) => void;
  cases: readonly EvaluationCase[];
  role: SessionIdentity['role'];
  busy: boolean;
  onImport: () => void;
  onArchive: () => void;
  onEditMetadata: () => void;
}) {
  return (
    <SectionCard
      title={dataset.name}
      description={dataset.description}
      padding="flush"
      actions={
        <div className="ui-cluster">
          <Select
            id="evaluation-version-select"
            aria-label="Dataset version"
            value={String(selectedVersion ?? '')}
            onChange={(value) => onVersionChange(Number(value))}
            options={versions.map((version) => ({
              value: String(version.version),
              label: `v${version.version} · ${version.fingerprint.slice(0, 12)}`,
            }))}
          />
          {role !== 'viewer' && (
            <Button variant="secondary" type="button" onClick={onEditMetadata}>
              Edit metadata
            </Button>
          )}
          {role !== 'viewer' && (
            <Button variant="primary" type="button" onClick={onImport}>
              Import version
            </Button>
          )}
          {role === 'admin' && (
            <Button variant="danger" type="button" onClick={onArchive} disabled={busy}>
              Archive
            </Button>
          )}
        </div>
      }
    >
      {cases.length === 0 ? (
        <EmptyStateV2 variant="first-run" title="No cases in this version">
          Import a JSON corpus to create the first immutable version.
        </EmptyStateV2>
      ) : (
        <EvaluationCasesTable cases={cases} />
      )}
    </SectionCard>
  );
}
