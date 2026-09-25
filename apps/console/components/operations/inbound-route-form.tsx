import type { FormEvent } from 'react';
import type { Release, ProviderBinding, SessionIdentity } from '../../lib/api';
import type { InboundRouteRecord } from '../../lib/operator-api';
import type { PluginOption } from '../plugins/types';
import { Field } from '../primitives';
import { formatTime } from '../../lib/format';
const displayTime = formatTime;
export function InboundRouteForm({ editing, phoneNumber, setPhoneNumber, releaseId, setReleaseId,
  carrierPluginId, setCarrierPluginId, carrierBindingId, setCarrierBindingId, variables, setVariables,
  enabled, setEnabled, releases, carriers, bindings, role, busy, onSave, onCancel }: {
  editing?: InboundRouteRecord; phoneNumber: string; setPhoneNumber: (value: string) => void;
  releaseId: string; setReleaseId: (value: string) => void;
  carrierPluginId: string; setCarrierPluginId: (value: string) => void;
  carrierBindingId: string; setCarrierBindingId: (value: string) => void;
  variables: string; setVariables: (value: string) => void;
  enabled: boolean; setEnabled: (value: boolean) => void;
  releases: Array<Release & { agentName: string }>;
  carriers: PluginOption[]; bindings: ProviderBinding[];
  role: SessionIdentity['role']; busy: boolean;
  onSave: (event: FormEvent<HTMLFormElement>) => Promise<void>; onCancel: () => void;
}) {
  return (
        <form className="nested-card stack" onSubmit={onSave}>
          <strong>{editing ? `Edit route v${editing.version}` : 'Add inbound route'}</strong>
          <div className="form-grid">
            <Field label="Inbound phone number" htmlFor="inbound-route-number">
              <input
                id="inbound-route-number"
                type="tel"
                placeholder="+91…"
                pattern="\+[1-9][0-9]{7,14}"
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                disabled={role !== 'admin' || Boolean(editing)}
                required
              />
            </Field>
            <Field label="Immutable release" htmlFor="inbound-route-release">
              <select
                id="inbound-route-release"
                value={releaseId}
                onChange={(event) => setReleaseId(event.target.value)}
                disabled={role !== 'admin'}
                required
              >
                <option value="">Select immutable release</option>
                {releases.map((release) => (
                  <option key={release.id} value={release.id}>
                    {release.agentName} · {release.id} · {displayTime(release.createdAt)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Carrier plugin" htmlFor="inbound-route-carrier">
              <select id="inbound-route-carrier" value={carrierPluginId} disabled={role !== 'admin'} onChange={event => { setCarrierPluginId(event.target.value); setCarrierBindingId(''); }}>
                <option value="">Environment carrier</option>
                {carriers.map(carrier => <option key={carrier.id} value={carrier.id}>{carrier.ui?.label ?? carrier.id}</option>)}
              </select>
            </Field>
            <Field label="Carrier binding" htmlFor="inbound-route-carrier-binding">
              <select id="inbound-route-carrier-binding" value={carrierBindingId} disabled={role !== 'admin'} onChange={event => setCarrierBindingId(event.target.value)}>
                <option value="">Environment binding</option>
                {bindings.filter(binding => binding.pluginId === carrierPluginId).map(binding => <option key={binding.id} value={binding.id}>{binding.label}</option>)}
              </select>
            </Field>
            <Field
              label="Release variables JSON"
              htmlFor="inbound-route-variables"
              help="Use a JSON object whose values are strings. The API validates required variables against the selected release."
            >
              <textarea
                id="inbound-route-variables"
                className="code-input compact"
                value={variables}
                onChange={(event) => setVariables(event.target.value)}
                disabled={role !== 'admin'}
                required
              />
            </Field>
            <label className="checkbox-row" htmlFor="inbound-route-enabled">
              <input
                id="inbound-route-enabled"
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                disabled={role !== 'admin'}
              />
              <span>Accept inbound admission on this route</span>
            </label>
          </div>
          <div className="button-row">
            <button className="button primary" disabled={role !== 'admin' || busy}>
              {busy ? 'Saving…' : editing ? 'Save route version' : 'Create route'}
            </button>
            {editing && (
              <button className="button" type="button" onClick={onCancel} disabled={busy}>
                Cancel edit
              </button>
            )}
          </div>
        </form>
  );
}
