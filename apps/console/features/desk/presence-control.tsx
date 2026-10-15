'use client';
import { useState } from 'react';
import { StatusBadgeV2 } from '../../components/ui/status-badge';
import { OPERATOR_STATUSES, type OperatorStatus } from '../../lib/types/desk';
import { MicTestDialog } from './mic-test';

const LABEL: Record<OperatorStatus, string> = {
  AVAILABLE: 'Available',
  AWAY: 'Away',
  OFFLINE: 'Offline',
};

/**
 * The Available / Away / Offline control. Going Available is the one transition that needs the
 * microphone proven first (a user gesture, so the browser also allows audio playback afterwards).
 */
export function PresenceControl({
  status,
  disabledReason,
  deviceId,
  onChange,
  onDevice,
}: {
  status: OperatorStatus;
  /** Why Available cannot be chosen (the room is unreachable); Away and Offline stay open. */
  disabledReason?: string;
  deviceId?: string;
  onChange: (status: OperatorStatus) => void;
  onDevice: (deviceId: string | undefined) => void;
}) {
  const [testing, setTesting] = useState(false);
  return (
    <div className="desk-presence">
      <div role="radiogroup" aria-label="Presence" className="desk-segmented">
        {OPERATOR_STATUSES.map((option) => {
          const blocked = option === 'AVAILABLE' && disabledReason !== undefined;
          return (
            <label key={option} className={status === option ? 'is-selected' : undefined}>
              <input
                type="radio"
                name="desk-presence"
                value={option}
                checked={status === option}
                disabled={blocked}
                aria-describedby={blocked ? 'desk-presence-reason' : undefined}
                onChange={() => (option === 'AVAILABLE' ? setTesting(true) : onChange(option))}
              />
              <span>{LABEL[option]}</span>
            </label>
          );
        })}
      </div>
      <StatusBadgeV2 value={status.toLowerCase()} label={LABEL[status]} />
      {disabledReason && (
        <small id="desk-presence-reason" className="muted">
          {disabledReason}
        </small>
      )}
      <MicTestDialog
        open={testing}
        initialDeviceId={deviceId}
        onCancel={() => setTesting(false)}
        onConfirm={(device) => {
          setTesting(false);
          onDevice(device);
          onChange('AVAILABLE');
        }}
      />
    </div>
  );
}
