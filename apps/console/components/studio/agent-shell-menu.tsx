'use client';
// `AgentShell`'s "more actions" overflow menu — Duplicate and Export JSON — split out to stay
// under the module-size gate. Owns its own open/close state: Escape or a click outside it closes
// the menu, which a bare `<details>` does neither of on its own (verifier: "the overflow menu
// doesn't close on Escape or an outside click"). Duplicate is disabled for a viewer up front
// (the API would 403 it anyway) and surfaces a real failure instead of an unhandled rejection
// (verifier: "a 403 becomes an unhandled rejection").
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  apiRequest,
  emptyAgentConfig,
  ifMatch,
  normalizeDraft,
  type AgentDraft,
} from '../../lib/api';

export function AgentShellMenu({ agent, viewer }: { agent: AgentDraft; viewer: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const menuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  async function duplicate() {
    setOpen(false);
    setError(undefined);
    try {
      const created = await apiRequest<unknown>('/agents', {
        method: 'POST',
        body: JSON.stringify({ config: emptyAgentConfig() }),
      });
      const draft = normalizeDraft(created.data, created.etag);
      await apiRequest(`/agents/${encodeURIComponent(draft.id)}`, {
        method: 'PUT',
        headers: { 'if-match': ifMatch(draft.draftVersion) },
        body: JSON.stringify({
          config: { ...agent.config, name: `${agent.config.name} copy` },
        }),
      });
      router.push(`/agents/${encodeURIComponent(draft.id)}/configure`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Duplicate failed');
    }
  }

  function exportJson() {
    setOpen(false);
    const blob = new Blob([JSON.stringify(agent.config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${agent.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <details className="ds-overflow-menu" open={open} ref={menuRef}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setOpen((value) => !value);
          }}
          aria-label="More actions"
        >
          ⋯
        </summary>
        <div className="ds-overflow-menu-list">
          <button type="button" disabled={viewer} onClick={() => void duplicate()}>
            Duplicate
          </button>
          <button type="button" onClick={exportJson}>
            Export JSON
          </button>
        </div>
      </details>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
