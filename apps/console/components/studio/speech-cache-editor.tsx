'use client';
import type { AgentConfig } from '../../lib/api';
import { Notice, Panel, PanelHeader, StatusBadge } from '../primitives';

export function SpeechCacheEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const policy = config.speechCache;
  const enabled = policy?.enabled === true;
  const announcementMode = config.mode === 'announcement';
  const patch = (speechCache: NonNullable<AgentConfig['speechCache']>) =>
    update({ ...config, speechCache });
  return (
    <Panel labelledBy="speech-cache-title">
      <PanelHeader
        id="speech-cache-title"
        title="Approved speech cache policy"
        badge={
          <StatusBadge tone={enabled ? 'good' : 'soft'}>
            {enabled ? 'Static phrases enabled' : 'Disabled'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) =>
              patch({ enabled: event.target.checked, announcement: policy?.announcement ?? false })
            }
          />
          <span>
            <strong>Cache exact configured processing phrases</strong>
            <small>
              Allows only the exact initial and progress phrases configured in this immutable
              release to use the live hybrid speech cache.
            </small>
          </span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={policy?.announcement === true}
            disabled={!enabled || !announcementMode}
            onChange={(event) => patch({ enabled: true, announcement: event.target.checked })}
          />
          <span>
            <strong>Also cache exact announcement text</strong>
            <small>
              {announcementMode
                ? 'Permits the exact configured announcement only.'
                : 'Available only for announcement-mode releases.'}
            </small>
          </span>
        </label>
        <Notice tone="warning">
          Dynamic responses, model output, caller data, context, and tool results are never made
          cache-eligible by this policy. Cache hits avoid repeated TTS generation only; carrier and
          media usage can still be billed.
        </Notice>
      </div>
    </Panel>
  );
}
