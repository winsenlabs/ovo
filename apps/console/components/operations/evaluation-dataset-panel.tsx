'use client';
import { useConfirm } from '../ui/dialog';
import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest, items, type SessionIdentity } from '../../lib/api';
import type {
  EvaluationCase,
  EvaluationDataset,
  EvaluationDatasetVersion,
} from '../../lib/operator-api';
import { formatRelativeTime } from '../../lib/format';
import { SectionCard } from '../ui/section-card';
import { RadioCardGroup } from '../ui/choice-card';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { Drawer } from '../ui/drawer';
import { parseEvaluationCorpus } from './evaluation-import';
import { EvaluationDatasetImport } from './evaluation-dataset-import';
import { EvaluationDatasetEditForm } from './evaluation-dataset-edit-form';
import { EvaluationDatasetDetail } from './evaluation-dataset-detail';
import { loadCases } from './load-evaluation-cases';

const NEW_DATASET = '';

/**
 * Immutable evaluation datasets as a card grid (one `RadioCardGroup` choice per dataset, plus a
 * "New dataset" choice), instead of a plain `<select>` with the metadata-edit form always above
 * the cases table.
 */
export function EvaluationDatasetPanel({
  role,
  datasets,
  reload,
}: {
  role: SessionIdentity['role'];
  datasets: readonly EvaluationDataset[];
  reload: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState('');
  const [versions, setVersions] = useState<EvaluationDatasetVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number>();
  const [cases, setCases] = useState<EvaluationCase[]>([]);
  const [importCases, setImportCases] = useState<unknown[]>();
  const [importName, setImportName] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selected = datasets.find((dataset) => dataset.id === selectedId);

  useEffect(() => {
    setSelectedId((current) =>
      current && (current === NEW_DATASET || datasets.some((dataset) => dataset.id === current))
        ? current
        : datasets[0]?.id || NEW_DATASET,
    );
  }, [datasets]);

  useEffect(() => {
    if (!selectedId) {
      setVersions([]);
      setSelectedVersion(undefined);
      return;
    }
    apiRequest<unknown>(`/evaluation-datasets/${encodeURIComponent(selectedId)}/versions?limit=100`)
      .then(({ data }) => {
        const next = items<EvaluationDatasetVersion>(data);
        setVersions(next);
        setSelectedVersion(next[0]?.version);
      })
      .catch((failure) => setError(message(failure, 'Dataset versions could not be loaded.')));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !selectedVersion) {
      setCases([]);
      return;
    }
    void loadCases(selectedId, selectedVersion)
      .then(setCases)
      .catch((failure) => setError(message(failure, 'Dataset cases could not be loaded.')));
  }, [selectedId, selectedVersion]);

  /** Returns whether the save succeeded, so callers that only need to close on success (the edit
   * drawer) don't have to re-derive it from `error`, which a stale closure could still read as
   * the previous attempt's message. */
  async function saveDataset(event: FormEvent<HTMLFormElement>): Promise<boolean> {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError(undefined);
    try {
      const { data } = await apiRequest<EvaluationDataset>(
        selected
          ? `/evaluation-datasets/${encodeURIComponent(selected.id)}`
          : '/evaluation-datasets',
        {
          method: selected ? 'PATCH' : 'POST',
          body: JSON.stringify({
            name: values.get('name'),
            description: values.get('description'),
          }),
        },
      );
      await reload();
      setSelectedId(data.id);
      return true;
    } catch (failure) {
      setError(message(failure, 'Dataset could not be saved.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (
      !selected ||
      !(await confirm(
        'Archive dataset',
        `Archive "${selected.name}"? Immutable versions remain evidence.`,
      ))
    )
      return;
    setBusy(true);
    try {
      await apiRequest(`/evaluation-datasets/${encodeURIComponent(selected.id)}`, {
        method: 'DELETE',
      });
      setSelectedId(NEW_DATASET);
      await reload();
    } catch (failure) {
      setError(message(failure, 'Dataset could not be archived.'));
    } finally {
      setBusy(false);
    }
  }

  async function importVersion() {
    if (!selected || !importCases) return;
    setBusy(true);
    setError(undefined);
    try {
      const { data } = await apiRequest<EvaluationDatasetVersion>(
        `/evaluation-datasets/${encodeURIComponent(selected.id)}/versions`,
        { method: 'POST', body: JSON.stringify({ cases: importCases }) },
      );
      setImportCases(undefined);
      setImportName('');
      setImportOpen(false);
      await reload();
      setVersions((current) => [data, ...current]);
      setSelectedVersion(data.version);
    } catch (failure) {
      setError(message(failure, 'Dataset version import failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function readImport(file?: File) {
    if (!file) return;
    setError(undefined);
    setImportCases(undefined);
    setImportName(file.name);
    try {
      setImportCases(parseEvaluationCorpus(await file.text()));
    } catch (failure) {
      setError(message(failure, 'The selected JSON file is invalid.'));
    }
  }

  const choices = [
    { value: NEW_DATASET, title: '+ New dataset', description: 'Start a new immutable corpus.' },
    ...datasets.map((dataset) => ({
      value: dataset.id,
      title: dataset.name,
      description: dataset.description || 'No description.',
      meta: (
        <small className="muted">
          v{dataset.currentVersion} · updated {formatRelativeTime(dataset.updatedAt)}
        </small>
      ),
    })),
  ];

  return (
    <div className="ds-stack">
      <SectionCard
        title="Immutable evaluation datasets"
        description="Fingerprinted case versions used by durable evaluation jobs."
      >
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        <RadioCardGroup
          name="dataset"
          value={selectedId}
          onChange={setSelectedId}
          choices={choices}
          columns={3}
          groupLabel="Dataset"
        />
      </SectionCard>
      {selectedId === NEW_DATASET ? (
        role === 'viewer' ? (
          <EmptyStateV2 variant="first-run" title="Select a dataset">
            Datasets hold immutable, fingerprinted case versions used by durable evaluation jobs.
          </EmptyStateV2>
        ) : (
          <SectionCard title="Create dataset" padding="prose">
            <form className="form-grid" onSubmit={saveDataset}>
              <div className="field">
                <label htmlFor="dataset-name">Name</label>
                <input id="dataset-name" name="name" required />
              </div>
              <div className="field">
                <label htmlFor="dataset-description">Description</label>
                <textarea id="dataset-description" name="description" />
              </div>
              <button className="button primary align-start" disabled={busy}>
                Create dataset
              </button>
            </form>
          </SectionCard>
        )
      ) : (
        selected && (
          <EvaluationDatasetDetail
            dataset={selected}
            versions={versions}
            selectedVersion={selectedVersion}
            onVersionChange={setSelectedVersion}
            cases={cases}
            role={role}
            busy={busy}
            onImport={() => setImportOpen(true)}
            onArchive={() => void archive()}
            onEditMetadata={() => setEditOpen(true)}
          />
        )
      )}
      {selected && role !== 'viewer' && (
        <Drawer
          open={importOpen}
          title={`Import a version into ${selected.name}`}
          onClose={() => setImportOpen(false)}
        >
          <EvaluationDatasetImport
            importCases={importCases}
            importName={importName}
            busy={busy}
            readImport={readImport}
            importVersion={importVersion}
          />
        </Drawer>
      )}
      {selected && role !== 'viewer' && (
        <Drawer open={editOpen} title={`Edit ${selected.name}`} onClose={() => setEditOpen(false)}>
          <EvaluationDatasetEditForm
            dataset={selected}
            busy={busy}
            error={error}
            onSubmit={(event) => void saveDataset(event).then((ok) => ok && setEditOpen(false))}
          />
        </Drawer>
      )}
    </div>
  );
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
