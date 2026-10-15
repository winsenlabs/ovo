'use client';
import type { FormEvent } from 'react';
import type { EvaluationDataset } from '../../lib/operator-api';

/** The "Edit metadata" drawer body for the selected dataset, extracted so
 * `EvaluationDatasetPanel` stays under the module-size gate. Editing an existing dataset's name
 * and description was lost when the metadata form moved behind the "+ New dataset" choice —
 * `saveDataset` could only ever take its POST branch (verifier major #2). */
export function EvaluationDatasetEditForm({
  dataset,
  busy,
  error,
  onSubmit,
}: {
  dataset: EvaluationDataset;
  busy: boolean;
  error?: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form key={dataset.id} className="form-grid" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="dataset-edit-name">Name</label>
        <input id="dataset-edit-name" name="name" required defaultValue={dataset.name} />
      </div>
      <div className="field">
        <label htmlFor="dataset-edit-description">Description</label>
        <textarea
          id="dataset-edit-description"
          name="description"
          defaultValue={dataset.description}
        />
      </div>
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
      <button className="button primary align-start" disabled={busy}>
        {busy ? 'Saving…' : 'Save metadata'}
      </button>
    </form>
  );
}
