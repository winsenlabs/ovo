'use client';
import { ResponsiveTable } from '../primitives';
import type { RecordingTrackSegment } from './production-track-player';
type Segment = RecordingTrackSegment & { timestampEvidence?: string; sha256?: string };
export function RecordingSegmentsTable({ segments, callBase, selectedId }: { segments: Segment[]; callBase: string; selectedId: string }) {
  return (
                <ResponsiveTable label="Recording segments">
                  <thead>
                    <tr>
                      <th>Track</th>
                      <th>Sequence</th>
                      <th>State</th>
                      <th>Window</th>
                      <th>Bytes</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segments.map((segment) => (
                      <tr key={`${segment.track}-${segment.sequence}`}>
                        <td>{segment.track}</td>
                        <td>{segment.sequence}</td>
                        <td>{segment.state}</td>
                        <td>
                          {segment.startMs}–{segment.endMs} ms
                        </td>
                        <td>{segment.bytes.toLocaleString()}</td>
                        <td>
                          {segment.state === 'available' ? (
                            <a
                              className="text-button"
                              href={`/api/v1${callBase}/${encodeURIComponent(selectedId)}/segments/${encodeURIComponent(segment.track)}/${segment.sequence}/audio`}
                              download
                            >
                              Download source μ-law segment
                            </a>
                          ) : (
                            (segment.timestampEvidence ?? 'Unavailable')
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </ResponsiveTable>
  );
}
