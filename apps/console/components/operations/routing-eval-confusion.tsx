'use client';
import type { CSSProperties } from 'react';
import type { ConfusionMatrix } from '../../lib/data/routing-eval-api';
import { humaniseEnum } from '../../lib/status';
import { matrixCells } from './routing-eval-model';

/** The deepest shade a cell gets, so its number stays readable on it in both themes. */
const MAX_TINT = 40;

/**
 * Expected branch (rows) against the branch chosen (columns) for one engine, as a numeric table
 * with the cells shaded by their share of the row: green on the diagonal (right), red off it
 * (wrong). The numbers carry the meaning; the shading only helps the eye.
 */
export function ConfusionTable({ engine, data }: { engine: string; data: ConfusionMatrix }) {
  const cells = matrixCells(data);
  const title = `${humaniseEnum(engine)} confusion matrix`;
  return (
    <div className="route-matrix-wrap" role="region" aria-label={title} tabIndex={0}>
      <table className="route-matrix">
        <caption>
          {humaniseEnum(engine)}: {data.correct} of {data.total} branches chosen correctly. Rows are
          the branch expected, columns the branch chosen.
        </caption>
        <thead>
          <tr>
            <th scope="col">Expected</th>
            {data.labels.map((label) => (
              <th scope="col" key={label}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.labels.map((label, row) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {cells[row]?.map((cell, column) => (
                <td
                  key={data.labels[column]}
                  className={cell.value ? (cell.diagonal ? 'is-right' : 'is-wrong') : 'is-zero'}
                  style={
                    { '--cell-tint': `${Math.round(cell.share * MAX_TINT)}%` } as CSSProperties
                  }
                >
                  {cell.value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
