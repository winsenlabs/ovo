type Manifest = { state: string; createdAt: string; expiresAt: string };
export function RecordingManifestMetadata({ manifest }: { manifest: Manifest }) {
  return (
                <dl className="metadata-list">
                  <div>
                    <dt>State</dt>
                    <dd>{manifest.state}</dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>8 kHz μ-law · two captured tracks</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{new Date(manifest.createdAt).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{new Date(manifest.expiresAt).toLocaleString()}</dd>
                  </div>
                </dl>
  );
}
