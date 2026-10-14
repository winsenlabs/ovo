import { KeyValueGrid } from '../ui/section-card';
import { RelativeTime } from '../ui/display';

type Manifest = { state: string; createdAt: string; expiresAt: string };

export function RecordingManifestMetadata({ manifest }: { manifest: Manifest }) {
  return (
    <KeyValueGrid
      columns={4}
      items={[
        { label: 'State', value: manifest.state },
        { label: 'Format', value: '8 kHz μ-law · two captured tracks' },
        { label: 'Created', value: <RelativeTime value={manifest.createdAt} /> },
        { label: 'Expires', value: <RelativeTime value={manifest.expiresAt} /> },
      ]}
    />
  );
}
