'use client';
import { useConfirm } from '../ui/dialog';
import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest, items, type SessionIdentity } from '../../lib/api';
import type {
  EvaluationCase,
  EvaluationDataset,
  EvaluationDatasetVersion,
} from '../../lib/operator-api';
import { EmptyState, Field, Panel, PanelHeader, StatusBadge } from '../primitives';
import { parseEvaluationCorpus } from './evaluation-import';
import { EvaluationDatasetImport } from './evaluation-dataset-import';
import { EvaluationCasesTable } from './evaluation-cases-table';
import { loadCases } from './load-evaluation-cases';

export function EvaluationDatasetPanel({
  role,
  datasets,
  reload,
}: {
  role: SessionIdentity['role'];
  datasets: EvaluationDataset[];
  reload: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState('');
  const [versions, setVersions] = useState<EvaluationDatasetVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number>();
  const [cases, setCases] = useState<EvaluationCase[]>([]);
  const [importCases, setImportCases] = useState<unknown[]>();
  const [importName, setImportName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selected = datasets.find((dataset) => dataset.id === selectedId);

  useEffect(() => {
    setSelectedId((current) =>
      current && datasets.some((dataset) => dataset.id === current)
        ? current
        : datasets[0]?.id || '',
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

  async function saveDataset(event: FormEvent<HTMLFormElement>) {
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
    } catch (failure) {
      setError(message(failure, 'Dataset could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (
      !selected ||
      !(await confirm(
        'Archive dataset',
        `Archive “${selected.name}”? Immutable versions remain evidence.`,
      ))
    )
      return;
    setBusy(true);
    try {
      await apiRequest(`/evaluation-datasets/${encodeURIComponent(selected.id)}`, {
        method: 'DELETE',
      });
      setSelectedId('');
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

  return (
    <Panel labelledBy="evaluation-datasets-title">
      <PanelHeader
        id="evaluation-datasets-title"
        title="Immutable evaluation datasets"
        badge={<StatusBadge tone="soft">{datasets.length} datasets</StatusBadge>}
      />
      <div className="panel-body stack">
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-grid">
          <Field label="Dataset" htmlFor="evaluation-dataset-select">
            <select
              id="evaluation-dataset-select"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">Create a new dataset</option>
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name} · v{dataset.currentVersion}
                </option>
              ))}
            </select>
          </Field>
          {selected && (
            <Field label="Immutable version" htmlFor="evaluation-version-select">
              <select
                id="evaluation-version-select"
                value={selectedVersion ?? ''}
                onChange={(event) => setSelectedVersion(Number(event.target.value))}
              >
                {versions.map((version) => (
                  <option key={version.version} value={version.version}>
                    v{version.version} · {version.fingerprint.slice(0, 12)}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {role !== 'viewer' && (
          <form className="nested-card stack" key={selected?.id ?? 'new'} onSubmit={saveDataset}>
            <h4>{selected ? 'Edit dataset metadata' : 'Create dataset'}</h4>
            <div className="form-grid">
              <Field label="Name" htmlFor="dataset-name">
                <input id="dataset-name" name="name" defaultValue={selected?.name} required />
              </Field>
              <Field label="Description" htmlFor="dataset-description">
                <textarea
                  id="dataset-description"
                  name="description"
                  defaultValue={selected?.description}
                />
              </Field>
            </div>
            <div className="button-row">
              <button className="button primary" disabled={busy}>
                {selected ? 'Save metadata' : 'Create dataset'}
              </button>
              {selected && (
                <button className="button" type="button" onClick={() => setSelectedId('')}>
                  New dataset
                </button>
              )}
              {selected && role === 'admin' && (
                <button className="button danger" type="button" onClick={archive} disabled={busy}>
                  Archive
                </button>
              )}
            </div>
          </form>
        )}
        {selected && role !== 'viewer' && (
          <EvaluationDatasetImport
            importCases={importCases}
            importName={importName}
            busy={busy}
            readImport={readImport}
            importVersion={importVersion}
          />
        )}
        {!selected ? (
          <EmptyState title="Select or create a dataset">
            Datasets hold immutable, fingerprinted case versions used by durable evaluation jobs.
          </EmptyState>
        ) : cases.length === 0 ? (
          <EmptyState title="No cases in this version">
            Import a JSON corpus to create the first immutable version.
          </EmptyState>
        ) : (
          <EvaluationCasesTable cases={cases} />
        )}
      </div>
    </Panel>
  );
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
