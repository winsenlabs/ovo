'use client';
import { FileDrop } from '../ui/inputs';
import { Button } from '../ui/button';

export function EvaluationDatasetImport({
  importCases,
  importName,
  busy,
  readImport,
  importVersion,
}: {
  importCases?: unknown[];
  importName: string;
  busy: boolean;
  readImport: (file?: File) => Promise<void>;
  importVersion: () => Promise<void>;
}) {
  return (
    <section className="stack" aria-labelledby="dataset-import-title">
      <h4 id="dataset-import-title">Import immutable JSON corpus</h4>
      <p className="muted">
        Upload one JSON array or <code>{'{"cases":[…]}'}</code>. Each production corpus is capped at
        120 deterministic cases.
      </p>
      <FileDrop
        accept=".json,application/json"
        hint="Drop a JSON file, or click to choose one"
        onFile={(file) => void readImport(file)}
      />
      {importCases && (
        <p className="muted">
          {importName}: {importCases.length} cases parsed locally. Server validation runs before the
          immutable version is created.
        </p>
      )}
      <Button
        variant="primary"
        type="button"
        disabled={!importCases || busy}
        onClick={() => void importVersion()}
      >
        Import as new version
      </Button>
    </section>
  );
}
