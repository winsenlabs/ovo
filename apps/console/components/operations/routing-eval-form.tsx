'use client';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import {
  loadRoutingReleaseOptions,
  routingEvalApi,
  type RoutingEvalRun,
  type RoutingReleaseOption,
} from '../../lib/data/routing-eval-api';
import { Button } from '../ui/button';
import { Switch } from '../ui/display';
import { InlineAlert, Skeleton } from '../ui/feedback-v2';
import { FileDrop } from '../ui/inputs';
import { parseRoutingCorpus } from './routing-eval-corpus';

type Releases =
  | { status: 'loading' }
  | { status: 'ready'; options: RoutingReleaseOption[] }
  | { status: 'error'; message: string };

/** The server's own refusal, with the case it names when it names one (413, 422). */
function refusal(failure: unknown): string {
  if (!(failure instanceof ApiError)) return 'The run could not be started.';
  const index = failure.details?.index;
  return typeof index === 'number' ? `Case ${index + 1}: ${failure.message}` : failure.message;
}

const defaultName = () => `Corpus ${new Date().toISOString().slice(0, 10)}`;

/**
 * Run a corpus against a published routing release: paste or upload JSON or JSONL, see the first
 * failing case named before anything is sent, then start the run. Scoring is offline: engine
 * answers come from the cases, so the run measures the tree, rules and pools.
 */
export function RoutingEvalForm({ onStarted }: { onStarted: (run: RoutingEvalRun) => void }) {
  const [releases, setReleases] = useState<Releases>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [releaseId, setReleaseId] = useState('');
  const [name, setName] = useState(defaultName);
  const [source, setSource] = useState('');
  // Untouched means undefined: the server's own flags apply (design 3.5), not an assumed "off".
  const [transferEnabled, setTransferEnabled] = useState<boolean>();
  const [humanQueueEnabled, setHumanQueueEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    setReleases({ status: 'loading' });
    loadRoutingReleaseOptions()
      .then((options) => {
        if (!current) return;
        setReleases({ status: 'ready', options });
        setReleaseId((chosen) => chosen || options[0]?.id || '');
      })
      .catch(
        (failure) =>
          current &&
          setReleases({
            status: 'error',
            message: failure instanceof Error ? failure.message : 'Releases could not be loaded.',
          }),
      );
    return () => {
      current = false;
    };
  }, [attempt]);

  const corpus = useMemo(() => (source.trim() ? parseRoutingCorpus(source) : null), [source]);
  const ready = corpus?.ok === true && releaseId !== '' && name.trim() !== '' && !busy;

  async function start(event: FormEvent) {
    event.preventDefault();
    if (corpus?.ok !== true) return;
    setBusy(true);
    setError(undefined);
    try {
      const run = await routingEvalApi.create({
        routingReleaseId: releaseId,
        name: name.trim(),
        cases: corpus.cases,
        ...(transferEnabled === undefined && humanQueueEnabled === undefined
          ? {}
          : {
              assume: {
                ...(transferEnabled === undefined ? {} : { transferEnabled }),
                ...(humanQueueEnabled === undefined ? {} : { humanQueueEnabled }),
              },
            }),
      });
      onStarted(run);
    } catch (failure) {
      setError(refusal(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={start}>
      <InlineAlert tone="info">
        Do not paste real caller data. Cases are stored with the run until you delete it.
      </InlineAlert>
      {releases.status === 'loading' && <Skeleton shape="line" width="100%" />}
      {releases.status === 'error' && (
        <InlineAlert onRetry={() => setAttempt((n) => n + 1)}>{releases.message}</InlineAlert>
      )}
      {releases.status === 'ready' && releases.options.length === 0 && (
        <InlineAlert tone="warn">
          There is no published routing release to score. Publish a routing point first.
        </InlineAlert>
      )}
      <div className="field">
        <label htmlFor="routing-eval-release">Routing release</label>
        <select
          id="routing-eval-release"
          value={releaseId}
          onChange={(event) => setReleaseId(event.target.value)}
          required
        >
          {releases.status === 'ready' &&
            releases.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="routing-eval-name">Run name</label>
        <input
          id="routing-eval-name"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </div>
      <FileDrop
        accept=".json,.jsonl,application/json"
        hint="Drop a .json or .jsonl corpus, or choose a file"
        onFile={(file) => void file.text().then(setSource)}
      />
      <div className="field">
        <label htmlFor="routing-eval-corpus">Corpus (JSON array or one case per line)</label>
        <textarea
          id="routing-eval-corpus"
          className="code-input"
          rows={10}
          spellCheck={false}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          aria-describedby="routing-eval-corpus-state"
        />
      </div>
      <div id="routing-eval-corpus-state" aria-live="polite">
        {corpus?.ok === false && <InlineAlert>{corpus.message}</InlineAlert>}
        {corpus?.ok === true && (
          <InlineAlert tone="info">{corpus.cases.length} cases are valid.</InlineAlert>
        )}
      </div>
      <p className="muted">
        Transfers and human queues are scored with this installation's settings unless you switch
        one here.
      </p>
      <div className="ui-cluster">
        <Switch
          checked={transferEnabled ?? false}
          onChange={setTransferEnabled}
          label="Assume transfers are on"
        />
        <Switch
          checked={humanQueueEnabled ?? false}
          onChange={setHumanQueueEnabled}
          label="Assume human queues are on"
        />
      </div>
      {error && <InlineAlert>{error}</InlineAlert>}
      <Button variant="primary" type="submit" disabled={!ready}>
        {busy ? 'Running…' : 'Run corpus'}
      </Button>
    </form>
  );
}
