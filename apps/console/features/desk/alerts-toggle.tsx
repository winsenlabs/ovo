'use client';
import { useState } from 'react';
import { chimeMuted, setChimeMuted } from './chime';

/** Chime on/off, and the opt-in for desktop notifications when the tab is in the background. */
export function AlertsToggle() {
  const [muted, setMuted] = useState(() => chimeMuted());
  const [permission, setPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  );
  return (
    <span className="button-row">
      <button
        type="button"
        className="text-button"
        aria-pressed={muted}
        onClick={() => {
          setChimeMuted(!muted);
          setMuted(!muted);
        }}
      >
        {muted ? 'Unmute chime' : 'Mute chime'}
      </button>
      {permission === 'default' && (
        <button
          type="button"
          className="text-button"
          onClick={() => void Notification.requestPermission().then(setPermission)}
        >
          Enable desktop alerts
        </button>
      )}
    </span>
  );
}
