'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listAudioDevices,
  MicrophoneError,
  probeMicrophone,
  type AudioDevice,
  type MicrophoneFailure,
  type MicrophoneProbe,
} from '@winsendotai/ovo-ui/room';
import { Dialog } from '../../components/ui/dialog';
import { InlineAlert } from '../../components/ui/feedback-v2';
import { Select } from '../../components/ui/inputs';
import { LevelMeter } from './level-meter';

const HINT: Record<MicrophoneFailure, string> = {
  denied:
    'The browser blocked the microphone. Allow it from the lock icon in the address bar, then test again.',
  not_found: 'No microphone was found. Plug in a headset and test again.',
  in_use: 'Another application is using the microphone. Close it and test again.',
  unsupported: 'This browser cannot capture audio here. Use a current browser over HTTPS.',
};

/**
 * "Test microphone": asks for permission, lets the operator pick a device and shows a live level
 * before they go Available, so a muted headset is found before a caller is waiting.
 */
export function MicTestDialog({
  open,
  initialDeviceId,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  initialDeviceId?: string;
  onCancel: () => void;
  onConfirm: (deviceId: string | undefined) => void;
}) {
  const probe = useRef<MicrophoneProbe>(undefined);
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [deviceId, setDeviceId] = useState(initialDeviceId ?? '');
  const [failure, setFailure] = useState<MicrophoneFailure>();
  const [testing, setTesting] = useState(false);

  const stop = useCallback(() => {
    probe.current?.stop();
    probe.current = undefined;
    setTesting(false);
  }, []);

  const start = useCallback(
    async (device: string) => {
      stop();
      setFailure(undefined);
      try {
        probe.current = await probeMicrophone(device || undefined);
        setTesting(true);
        // Labels only exist once permission is granted, so list after the first probe.
        setInputs((await listAudioDevices()).inputs);
      } catch (error) {
        setFailure(error instanceof MicrophoneError ? error.reason : 'unsupported');
      }
    },
    [stop],
  );

  useEffect(() => {
    if (!open) stop();
    return stop;
  }, [open, stop]);

  return (
    <Dialog open={open} onClose={onCancel} title="Test your microphone">
      <div className="desk-mic">
        <p className="muted">
          Check that callers will hear you before you go Available. Speak and watch the level move.
        </p>
        {failure && <InlineAlert tone="danger">{HINT[failure]}</InlineAlert>}
        {inputs.length > 0 && (
          <div className="field">
            <label htmlFor="desk-mic-device">Microphone</label>
            <Select
              id="desk-mic-device"
              value={deviceId}
              onChange={(next) => {
                setDeviceId(next);
                void start(next);
              }}
              options={inputs.map((device) => ({ value: device.id, label: device.label }))}
              placeholder="System default"
            />
          </div>
        )}
        <LevelMeter
          label="Microphone level"
          level={() => probe.current?.level() ?? 0}
          active={testing}
        />
        <div className="button-row">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button" onClick={() => void start(deviceId)}>
            {testing ? 'Test again' : 'Test microphone'}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!testing}
            onClick={() => {
              stop();
              onConfirm(deviceId || undefined);
            }}
          >
            Go available
          </button>
        </div>
      </div>
    </Dialog>
  );
}
