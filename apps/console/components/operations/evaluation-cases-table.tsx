import type { EvaluationCase } from '../../lib/operator-api';
import { ResponsiveTable } from '../primitives';
export function EvaluationCasesTable({ cases }: { cases: EvaluationCase[] }) {
  return (
          <ResponsiveTable label="Evaluation dataset cases">
            <thead>
              <tr>
                <th>Case</th>
                <th>Mode</th>
                <th>Tags</th>
                <th>Turns</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.title}</strong>
                    <small className="mono">{item.id}</small>
                  </td>
                  <td>{item.mode}</td>
                  <td>{item.tags.join(', ') || '—'}</td>
                  <td>{item.turns.length}</td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
  );
}
