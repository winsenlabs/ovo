'use client';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { dataTableRenderKey } from '../../lib/data-table-remount-key';
import { humaniseEnum } from '../../lib/status';
import type { RecordingTrackSegment } from './production-track-player';

type Segment = RecordingTrackSegment & { timestampEvidence?: string; sha256?: string };

/** Per-segment evidence table: which µ-law chunks are available to download, by track and
 * sequence, inside the Recording files tab. */
export function RecordingSegmentsTable({
  segments,
  callBase,
  selectedId,
}: {
  segments: Segment[];
  callBase: string;
  selectedId: string;
}) {
  const columns: ColumnV2<Segment>[] = [
    { id: 'track', header: 'Track', cell: (segment) => humaniseEnum(segment.track) },
    {
      id: 'sequence',
      header: 'Sequence',
      cell: (segment) => segment.sequence,
      sortValue: (segment) => segment.sequence,
    },
    { id: 'state', header: 'State', cell: (segment) => humaniseEnum(segment.state) },
    { id: 'window', header: 'Window', cell: (segment) => `${segment.startMs}–${segment.endMs} ms` },
    {
      id: 'bytes',
      header: 'Bytes',
      align: 'end',
      cell: (segment) => segment.bytes.toLocaleString('en-IN'),
    },
    {
      id: 'evidence',
      header: 'Evidence',
      cell: (segment) =>
        segment.state === 'available' ? (
          <a
            className="text-button"
            href={`/api/v1${callBase}/${encodeURIComponent(selectedId)}/segments/${encodeURIComponent(segment.track)}/${segment.sequence}/audio`}
            download
          >
            Download segment
          </a>
        ) : (
          (segment.timestampEvidence ?? 'Unavailable')
        ),
    },
  ];
  return (
    <DataTableV2
      key={dataTableRenderKey(false, undefined, segments.length)}
      label="Recording segments"
      rows={segments}
      rowKey={(segment) => `${segment.track}-${segment.sequence}`}
      columns={columns}
    />
  );
}
