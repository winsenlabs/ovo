'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import type { InboundRouteRecord } from '../../lib/operator-api';
import { useConfirm } from '../ui/dialog';
import { formatPhoneNumber } from '../../lib/format';
import { inboundRoutePath } from './inbound-route-state';
import { variableRowsFromRecord, variablesFromRows, type VariableRow } from './inbound-route-form';

export type InboundRouteDraft = {
  phoneNumber: string;
  releaseId: string;
  carrierPluginId: string;
  carrierBindingId: string;
  enabled: boolean;
  variableRows: VariableRow[];
};

const emptyDraft: InboundRouteDraft = {
  phoneNumber: '',
  releaseId: '',
  carrierPluginId: '',
  carrierBindingId: '',
  enabled: true,
  variableRows: [{ key: '', value: '' }],
};

/**
 * The add/edit drawer's state and its save/delete mutations, including the conflict-recovery
 * reload. Split out of `InboundRoutes` purely to keep that module under the size gate — this
 * hook owns the drawer and draft, the view owns the loaded list and renders the form.
 */
export function useInboundRouteEditor({
  loadRoutes,
}: {
  loadRoutes: (cursor?: string) => Promise<InboundRouteRecord[]>;
}) {
  const confirm = useConfirm();
  const [drawer, setDrawer] = useState<'add' | 'edit' | null>(null);
  const [editing, setEditing] = useState<InboundRouteRecord>();
  const [draft, setDraft] = useState<InboundRouteDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  function openAdd() {
    setEditing(undefined);
    setDraft(emptyDraft);
    setDrawer('add');
  }
  function openEdit(route: InboundRouteRecord) {
    setEditing(route);
    setDraft({
      phoneNumber: route.phoneNumber,
      // A routed number has no agent release: the operator picks one to switch it to an agent.
      releaseId: route.releaseId ?? '',
      carrierPluginId: route.carrierPluginId ?? '',
      carrierBindingId: route.carrierBindingId ?? '',
      enabled: route.enabled,
      variableRows: variableRowsFromRecord(route.variables),
    });
    setError(undefined);
    setNotice(undefined);
    setDrawer('edit');
  }
  function closeDrawer() {
    setDrawer(null);
    setEditing(undefined);
  }

  async function recoverFromConflict(action: string) {
    closeDrawer();
    try {
      await loadRoutes();
    } finally {
      setError(`The route changed before it could be ${action}. The latest list was reloaded.`);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const { data } = await apiRequest<InboundRouteRecord>(inboundRoutePath(draft.phoneNumber), {
        method: 'PUT',
        body: JSON.stringify({
          expectedVersion: editing?.version ?? null,
          releaseId: draft.releaseId,
          variables: variablesFromRows(draft.variableRows),
          enabled: draft.enabled,
          carrierPluginId: draft.carrierPluginId || null,
          carrierBindingId: draft.carrierBindingId || null,
        }),
      });
      setNotice(
        `Inbound route ${formatPhoneNumber(data.phoneNumber)} saved as version ${data.version}.`,
      );
      closeDrawer();
      await loadRoutes();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        await recoverFromConflict('saved');
      } else {
        setError(failure instanceof Error ? failure.message : 'Inbound route could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(route: InboundRouteRecord) {
    if (
      !(await confirm(
        'Delete inbound route',
        `Delete inbound route ${formatPhoneNumber(route.phoneNumber)}?`,
      ))
    )
      return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await apiRequest(`${inboundRoutePath(route.phoneNumber)}?expectedVersion=${route.version}`, {
        method: 'DELETE',
      });
      if (editing?.phoneNumber === route.phoneNumber) closeDrawer();
      setNotice(`Inbound route ${formatPhoneNumber(route.phoneNumber)} was deleted.`);
      await loadRoutes();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        await recoverFromConflict('deleted');
      } else {
        setError(
          failure instanceof Error ? failure.message : 'Inbound route could not be deleted.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return {
    drawer,
    editing,
    draft,
    setDraft,
    busy,
    error,
    setError,
    notice,
    openAdd,
    openEdit,
    closeDrawer,
    save,
    remove,
  };
}
