'use client';
import { Notice } from '../primitives';
export function EvaluationDatasetImport({ importCases, importName, busy, readImport, importVersion }: {
  importCases?: unknown[]; importName: string; busy: boolean;
  readImport: (file?: File) => Promise<void>;
  importVersion: () => Promise<void>;
}) {
  return (
          <section className="nested-card stack" aria-labelledby="dataset-import-title">
            <h4 id="dataset-import-title">Import immutable JSON corpus</h4>
            <p className="muted">
              Upload one JSON array or <code>{'{"cases":[…]}'}</code>. The console caps each
              production corpus at 120 deterministic cases.
            </p>
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Evaluation cases JSON file"
              onChange={(event) => void readImport(event.target.files?.[0])}
            />
            {importCases && (
              <div className="muted">
                {importName}: {importCases.length} cases parsed locally. Server validation runs
                before the immutable version is created.
              </div>
            )}
            <button
              className="button align-start"
              type="button"
              disabled={!importCases || busy}
              onClick={importVersion}
            >
              Import as new version
            </button>
          </section>
  );
}
