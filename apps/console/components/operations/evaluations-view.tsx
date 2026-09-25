'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, items, normalizeDraft, type Evaluation, type Release } from '../../lib/api';
import {
  EmptyState,
  Field,
  JsonEvidence,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import { parseFollowUpInputs, simulationRequest, type SimulationMode } from './simulation-request';
import { SimulationPanel } from './simulation-panel';
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
export function TestAndEvaluationView({
  evaluationsOnly = false,
  simulationsOnly = false,
  embedded = false,
}: {
  evaluationsOnly?: boolean;
  simulationsOnly?: boolean;
  embedded?: boolean;
}) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{
    tone: 'neutral' | 'danger' | 'warning';
    text: string;
  }>();
  const [result, setResult] = useState<unknown>();
  const [simulationMode, setSimulationMode] = useState<SimulationMode>('fixture');
  const [simulationBindings, setSimulationBindings] = useState<Record<string, unknown>>({});
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: evaluationPayload }, { data: agentPayload }] = await Promise.all([
        apiRequest<unknown>('/evaluations'),
        apiRequest<unknown>('/agents'),
      ]);
      setEvaluations(items(evaluationPayload));
      const agents = items<Record<string, unknown>>(agentPayload)
        .filter((agent) => agent.config)
        .map((agent) => normalizeDraft(agent));
      const histories = await Promise.all(
        agents.map((agent) =>
          apiRequest<unknown>(`/agents/${agent.id}/releases`)
            .then(({ data }) => items<Release>(data))
            .catch(() => []),
        ),
      );
      setReleases(histories.flat());
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: errorMessage(error, 'Release evidence could not be loaded.'),
      });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function simulate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setMessage(undefined);
    setResult(undefined);
    try {
      const followUpInputs = parseFollowUpInputs(String(values.get('followUpInputs') ?? ''));
      const { data } = await apiRequest('/simulations', {
        method: 'POST',
        body: JSON.stringify(
          simulationRequest(
            values.get('releaseId'),
            values.get('input'),
            simulationMode,
            simulationBindings,
            followUpInputs,
          ),
        ),
      });
      setResult(data);
      setMessage({
        tone: 'neutral',
        text:
          simulationMode === 'fixture'
            ? 'Fixture simulation completed without provider or tool requests. No carrier call was placed.'
            : 'Provider-backed simulation completed. Review its usage and call events; no carrier call was placed.',
      });
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: errorMessage(error, 'Simulation could not run. No output was invented.'),
      });
    }
  }

  async function evaluate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setMessage(undefined);
    setResult(undefined);
    let fixtures: unknown;
    try {
      fixtures = JSON.parse(String(values.get('fixtures')));
      if (!Array.isArray(fixtures)) throw new Error();
    } catch {
      setMessage({ tone: 'danger', text: 'Fixtures must be a JSON array.' });
      return;
    }
    try {
      const { data } = await apiRequest('/evaluations', {
        method: 'POST',
        body: JSON.stringify({ releaseId: values.get('releaseId'), fixtures }),
      });
      setResult(data);
      setMessage({
        tone: 'neutral',
        text: 'Evaluation outcomes were stored by the management API.',
      });
      await load();
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: errorMessage(error, 'Evaluation failed. No passing evidence was asserted.'),
      });
    }
  }

  if (loading) return <LoadingBlock label="Loading releases and evaluations" />;
  return (
    <div className="stack">
      {!embedded && (
        <header className="page-heading">
          <div>
            <p className="eyebrow">Test and release</p>
            <h1>{evaluationsOnly ? 'Evaluations' : 'Simulation'}</h1>
            <p className="muted">
              Runs use immutable releases. Fixture outcomes are stored evidence, not production
              certification.
            </p>
          </div>
        </header>
      )}
      {message && (
        <Notice tone={message.tone} live>
          {message.text}
        </Notice>
      )}
      {!evaluationsOnly && <SimulationPanel releases={releases} simulationMode={simulationMode} setSimulationMode={setSimulationMode} simulationBindings={simulationBindings} setSimulationBindings={setSimulationBindings} simulate={simulate} />}
      {!simulationsOnly && (
        <>
          <Panel labelledBy="evaluation-run-title">
            <PanelHeader
              id="evaluation-run-title"
              title="Run objective fixtures"
              badge={<StatusBadge>{evaluations.length} stored runs</StatusBadge>}
            />
            <form className="panel-body stack" onSubmit={evaluate}>
              <Field label="Immutable release" htmlFor="evaluation-release">
                <select id="evaluation-release" name="releaseId" required>
                  <option value="">Select release</option>
                  {releases.map((release) => (
                    <option key={release.id} value={release.id}>
                      {release.config.name} · {release.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Fixture JSON"
                htmlFor="evaluation-fixtures"
                help="Each fixture may include id, input, variables, expectedOutput and forbiddenOutput."
              >
                <textarea
                  id="evaluation-fixtures"
                  name="fixtures"
                  className="code-input"
                  defaultValue={
                    '[\n  {\n    "id": "example",\n    "input": "Hello",\n    "expectedOutput": ""\n  }\n]'
                  }
                  required
                />
              </Field>
              <button className="button primary align-start" disabled={!releases.length}>
                Run and store evaluation
              </button>
            </form>
          </Panel>
          {result !== undefined && (
            <Panel labelledBy="run-result-title">
              <PanelHeader
                id="run-result-title"
                title="API result"
                badge={<StatusBadge tone="good">Stored response</StatusBadge>}
              />
              <div className="panel-body">
                <JsonEvidence
                  label="Final text, all-turn timeline, and assertions"
                  value={result}
                />
              </div>
            </Panel>
          )}
          <Panel labelledBy="stored-evaluations-title">
            <PanelHeader id="stored-evaluations-title" title="Stored evaluation evidence" />
            {evaluations.length === 0 ? (
              <div className="panel-body">
                <EmptyState title="No evaluations stored">
                  The API returned an honest empty collection. No fixture was marked passing.
                </EmptyState>
              </div>
            ) : (
              <ResponsiveTable label="Stored evaluation runs">
                <thead>
                  <tr>
                    <th>Evaluation</th>
                    <th>Release</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluations.map((evaluation) => (
                    <tr key={evaluation.id}>
                      <td className="mono">{evaluation.id}</td>
                      <td className="mono">{evaluation.releaseId ?? 'Not supplied'}</td>
                      <td>{evaluation.status ?? 'Outcome in evidence detail'}</td>
                      <td>
                        {evaluation.createdAt
                          ? new Date(evaluation.createdAt).toLocaleString()
                          : 'Not supplied'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTable>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
