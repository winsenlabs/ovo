'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { routingApi } from '../../lib/data/routing-api';
import { useRoutingLoad } from '../../lib/data/use-routing-load';
import { formatDuration } from '../../lib/format';
import type { AudioRecord } from '../../lib/types/routing';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { useConfirmDialog } from '../ui/dialog';
import { EmptyStateV2, InlineAlert } from '../ui/feedback-v2';
import { FileDrop } from '../ui/inputs';
import { TextField } from './fields';

export const CLIP_MAX_BYTES = 10 * 1024 * 1024;
type User = { id: string; name: string };

/**
 * Hold clips: list, preview (played from a blob URL), upload a WAV (10 MiB at most) and delete.
 * A clip a point still names cannot be deleted: the button says why and the API's refusal is
 * shown with the points that use it.
 */
export function ClipManager({
  canEdit,
  users,
  onChanged,
}: {
  canEdit: boolean;
  users?: ReadonlyMap<string, User[]>;
  onChanged?: () => void;
}) {
  const { state, reload } = useRoutingLoad(routingApi.audio);
  const [notice, setNotice] = useState<{ tone: 'danger' | 'info'; text: string }>();
  const [file, setFile] = useState<File>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ clip: AudioRecord; url: string }>();
  const url = useRef<string | undefined>(undefined);
  const { confirm, dialog } = useConfirmDialog();
  useEffect(() => () => void (url.current && URL.revokeObjectURL(url.current)), []);

  const play = async (clip: AudioRecord) => {
    try {
      const blob = await routingApi.audioBlob(clip.id);
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(blob);
      setPreview({ clip, url: url.current });
    } catch {
      setNotice({ tone: 'danger', text: `“${clip.name}” could not be loaded for preview.` });
    }
  };
  const upload = async () => {
    if (!file) return;
    if (file.size > CLIP_MAX_BYTES)
      return setNotice({ tone: 'danger', text: 'A clip is at most 10 MiB.' });
    setBusy(true);
    try {
      await routingApi.uploadAudio(name.trim() || file.name.replace(/\.[^.]+$/, ''), file);
      setFile(undefined);
      setName('');
      setNotice({ tone: 'info', text: 'Clip uploaded.' });
      await reload();
      onChanged?.();
    } catch (failure) {
      setNotice({
        tone: 'danger',
        text: failure instanceof Error ? failure.message : 'Upload failed.',
      });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (clip: AudioRecord) => {
    if (
      !(await confirm(
        'Delete clip',
        `Delete “${clip.name}”? Releases that already use it keep playing it.`,
      ))
    )
      return;
    try {
      await routingApi.removeAudio(clip.id);
      setNotice(undefined);
      if (preview?.clip.id === clip.id) setPreview(undefined);
      await reload();
      onChanged?.();
    } catch (failure) {
      const used = failure instanceof ApiError ? failure.details?.inUseBy : undefined;
      setNotice({
        tone: 'danger',
        text: Array.isArray(used)
          ? `“${clip.name}” is still used by ${used.map((id) => users?.get(clip.id)?.find((u) => u.id === id)?.name ?? id).join(', ')}. Remove it from their hold first.`
          : failure instanceof Error
            ? failure.message
            : 'The clip could not be deleted.',
      });
    }
  };

  const columns: ColumnV2<AudioRecord>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: (c) => <strong>{c.name}</strong>,
      sortValue: (c) => c.name,
    },
    { id: 'length', header: 'Length', align: 'end', cell: (c) => formatDuration(c.durationMs) },
    {
      id: 'size',
      header: 'Size',
      align: 'end',
      priority: 'low',
      cell: (c) => `${Math.round(c.byteLength / 1024)} KiB`,
    },
    {
      id: 'usedBy',
      header: 'Used by',
      priority: 'low',
      cell: (c) =>
        users
          ?.get(c.id)
          ?.map((u) => u.name)
          .join(', ') || <span className="muted">Nothing yet</span>,
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (c) => {
        const used = users?.get(c.id)?.length;
        return (
          <span className="button-row">
            <button
              type="button"
              className="button small"
              aria-label={`Play ${c.name}`}
              onClick={() => void play(c)}
            >
              Play
            </button>
            {canEdit && (
              <button
                type="button"
                className="button small danger"
                aria-label={`Delete ${c.name}`}
                disabled={Boolean(used)}
                title={used ? 'In use by a routing point' : undefined}
                onClick={() => void remove(c)}
              >
                Delete
              </button>
            )}
          </span>
        );
      },
    },
  ];
  return (
    <div className="rt-clips">
      {notice && <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert>}
      {canEdit && (
        <div className="rt-upload">
          <FileDrop
            accept=".wav,audio/wav,audio/x-wav"
            hint="Drop a WAV file here, or choose one (10 MiB at most)"
            onFile={(f) => {
              setFile(f);
              setName(f.name.replace(/\.[^.]+$/, ''));
            }}
          />
          {file && (
            <div className="button-row">
              <TextField id="clip-name" label="Clip name" value={name} onChange={setName} />
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => void upload()}
              >
                {busy ? 'Uploading…' : 'Upload clip'}
              </button>
            </div>
          )}
        </div>
      )}
      {preview && (
        <div className="rt-preview">
          <strong>{preview.clip.name}</strong>
          <audio controls src={preview.url} aria-label={`Preview of ${preview.clip.name}`} />
        </div>
      )}
      <DataTableV2
        label="Hold clips"
        rows={state.status === 'ready' ? state.data : []}
        columns={columns}
        rowKey={(c) => c.id}
        loading={state.status === 'loading'}
        error={state.status === 'error' ? state.message : undefined}
        onRetry={() => void reload()}
        empty={
          state.status === 'disabled' ? (
            <EmptyStateV2 variant="unavailable" title="Routing is not enabled here" />
          ) : (
            <EmptyStateV2 title="No hold clips yet">
              Upload music or a recording a caller hears while they wait to be transferred.
            </EmptyStateV2>
          )
        }
      />
      {dialog}
    </div>
  );
}
