'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError, items, type SessionIdentity } from '../../lib/api';
import { LoadingBlock } from '../primitives';
import { CliRegistryPanel } from './cli-registry-panel';
import { ComplaintsPanel } from './complaints-panel';
import { ComplianceEvidencePanel } from './compliance-evidence-panel';
import { ComplianceSettingsPanel } from './compliance-settings-panel';
import {
  failureText,
  type A2pDeclaration,
  type CliNumber,
  type CliRatio,
  type Complaint,
  type SettingsRecord,
} from './compliance-types';
import { ConsentRecordsPanel } from './consent-records-panel';

interface Loaded {
  settings: SettingsRecord;
  numbers: CliNumber[];
  declarations: A2pDeclaration[];
  ratios: CliRatio[];
  complaints: Complaint[];
}

/**
 * India outbound compliance (TRAI TCCCPR, RBI recovery): sender settings, caller numbers and A2P
 * declarations, consent and DND scrub, complaints with SLA timers, ratios and the export.
 */
export function ComplianceView({ role }: { role: SessionIdentity['role'] }) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const editor = role !== 'viewer';
  const load = useCallback(async () => {
    try {
      const get = async <T,>(path: string) => (await apiRequest<T>(path)).data;
      const [settings, numbers, declarations, ratios, complaints] = await Promise.all([
        get<SettingsRecord>('/operations/compliance/settings'),
        get<unknown>('/operations/compliance/cli-numbers'),
        get<unknown>('/operations/compliance/a2p-declarations'),
        get<unknown>('/operations/compliance/ratios'),
        editor ? get<unknown>('/operations/compliance/complaints') : Promise.resolve([]),
      ]);
      setLoaded({
        settings,
        numbers: items(numbers),
        declarations: items(declarations),
        ratios: items(ratios),
        complaints: items(complaints),
      });
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'Operations are not configured on this installation.'
          : failureText(failure, 'Compliance settings unavailable.'),
      );
    }
  }, [editor]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Dial safety</p>
          <h1>Compliance</h1>
          <p className="muted">
            Every +91 call is checked against TRAI&rsquo;s rules and RBI&rsquo;s recovery hours
            before it is dialed. Settings here can only make the rules stricter.
          </p>
        </div>
        <button className="button" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
      {!loaded && !error && <LoadingBlock label="Loading compliance" />}
      {loaded && (
        <>
          <ComplianceSettingsPanel
            record={loaded.settings}
            canEdit={role === 'admin'}
            onSaved={load}
          />
          <CliRegistryPanel
            numbers={loaded.numbers}
            declarations={loaded.declarations}
            canEdit={role === 'admin'}
            onChanged={load}
          />
          {editor && (
            <ComplaintsPanel complaints={loaded.complaints} canEdit={editor} onChanged={load} />
          )}
          {editor && <ConsentRecordsPanel canEdit={editor} />}
          <ComplianceEvidencePanel ratios={loaded.ratios} canExport={role === 'admin'} />
        </>
      )}
    </div>
  );
}
