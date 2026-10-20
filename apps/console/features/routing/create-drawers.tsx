'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AgentSelect, useAgents } from '../../components/routing/agent-select';
import { TextField } from '../../components/routing/fields';
import { Drawer } from '../../components/ui/drawer';
import { InlineAlert } from '../../components/ui/feedback-v2';
import { ApiError } from '../../lib/api';
import { routingApi } from '../../lib/data/routing-api';
import { blankDraft } from '../../lib/derive/routing-defaults';
import { blankPool } from '../../lib/derive/routing-pools';

function Actions({ busy, label, onClose }: { busy: boolean; label: string; onClose: () => void }) {
  return (
    <div className="button-row queue-form-actions">
      <button type="button" className="button" onClick={onClose}>
        Cancel
      </button>
      <button type="submit" className="button primary" disabled={busy}>
        {busy ? 'Creating…' : label}
      </button>
    </div>
  );
}

const failureText = (failure: unknown, fallback: string) =>
  failure instanceof ApiError && failure.code === 'routing_pool_name_taken'
    ? 'Another pool already has this name.'
    : failure instanceof Error
      ? failure.message
      : fallback;

function PointForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const agents = useAgents();
  const [name, setName] = useState('');
  const [routerAgent, setRouterAgent] = useState('');
  const [defaultAgent, setDefaultAgent] = useState('');
  const [language, setLanguage] = useState('en');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !routerAgent || !defaultAgent)
      return setError('Give the point a name and choose its router and default agents.');
    if (!/^[a-z]{2,3}$/.test(language.trim()))
      return setError('The language is a code like en or hi.');
    setBusy(true);
    setError(undefined);
    try {
      const point = await routingApi.createPoint(
        blankDraft({
          name: name.trim(),
          routerAgentId: routerAgent,
          defaultAgentId: defaultAgent,
          language: language.trim(),
        }),
      );
      router.push(`/routing/points/${point.id}`);
    } catch (failure) {
      setError(failureText(failure, 'The point could not be created.'));
      setBusy(false);
    }
  }
  return (
    <form className="queue-form" onSubmit={submit} noValidate>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <TextField id="point-name" label="Name" value={name} onChange={setName} required />
      <AgentSelect
        id="point-router"
        label="Router agent"
        agents={agents}
        value={routerAgent}
        onChange={setRouterAgent}
        help="Its voice greets and questions the caller."
      />
      <AgentSelect
        id="point-default"
        label="Default agent"
        agents={agents}
        value={defaultAgent}
        onChange={setDefaultAgent}
        help="Where a call goes when nothing else can answer it."
      />
      <TextField
        id="point-language"
        label="Default language"
        value={language}
        onChange={setLanguage}
        help="A code such as en or hi."
      />
      <Actions busy={busy} label="Create point" onClose={onClose} />
    </form>
  );
}

function PoolForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const agents = useAgents();
  const [name, setName] = useState('');
  const [agent, setAgent] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !agent) return setError('Give the pool a name and choose its first agent.');
    setBusy(true);
    setError(undefined);
    try {
      const pool = await routingApi.createPool(blankPool(name.trim(), agent));
      router.push(`/routing/pools/${pool.id}`);
    } catch (failure) {
      setError(failureText(failure, 'The pool could not be created.'));
      setBusy(false);
    }
  }
  return (
    <form className="queue-form" onSubmit={submit} noValidate>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <TextField id="pool-name" label="Name" value={name} onChange={setName} required />
      <AgentSelect
        id="pool-agent"
        label="First member agent"
        agents={agents}
        value={agent}
        onChange={setAgent}
        help="Add more members, languages and hours on the next screen."
      />
      <Actions busy={busy} label="Create pool" onClose={onClose} />
    </form>
  );
}

export function CreatePointDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Drawer open={open} title="New routing point" onClose={onClose}>
      {open && <PointForm onClose={onClose} />}
    </Drawer>
  );
}

export function CreatePoolDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Drawer open={open} title="New pool" onClose={onClose}>
      {open && <PoolForm onClose={onClose} />}
    </Drawer>
  );
}
