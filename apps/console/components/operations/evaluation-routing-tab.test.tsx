import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogProvider } from '../ui/dialog';
import { evalSummary } from '../../tests/routing-eval-fixtures';
import { EvaluationDatasetsView } from './evaluation-datasets-view';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiRequest: request,
}));
vi.mock('./evaluation-runs-panel', () => ({ EvaluationRunsPanel: () => <p>Runs panel</p> }));
afterEach(() => {
  cleanup();
  request.mockReset();
});

describe('Evaluations: Routing tab', () => {
  it('sits beside the other tabs and shows the routing runs', async () => {
    request.mockImplementation(async (path: string) => ({
      data: path.startsWith('/routing/eval-runs') ? { items: [evalSummary()] } : { items: [] },
    }));
    render(
      <ConfirmDialogProvider>
        <EvaluationDatasetsView role="viewer" />
      </ConfirmDialogProvider>,
    );
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Runs',
      'Datasets',
      'Simulations',
      'Routing',
      'Provider access',
    ]);
    fireEvent.click(screen.getByRole('tab', { name: 'Routing' }));
    expect(await screen.findByRole('button', { name: 'Open run Worked examples' })).toBeTruthy();
    expect(screen.queryByText('Runs panel')).toBeNull();
  });
});
