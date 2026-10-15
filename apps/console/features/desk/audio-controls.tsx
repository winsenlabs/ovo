'use client';
import { useEffect, useState } from 'react';
import { listAudioDevices, type AudioDevices } from '@winsendotai/ovo-ui/room';
import { Select } from '../../components/ui/inputs';
import { LevelMeter } from './level-meter';

/** Mute, volume, devices and live levels for the call in progress. */
export function AudioControls({
  muted,
  volume,
  levels,
  active,
  onMute,
  onVolume,
  onInput,
  onOutput,
}: {
  muted: boolean;
  volume: number;
  levels: () => { input: number; output: number };
  active: boolean;
  onMute: (muted: boolean) => void;
  onVolume: (volume: number) => void;
  onInput: (deviceId: string) => void;
  onOutput: (deviceId: string) => void;
}) {
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [] });
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  useEffect(() => {
    if (active) void listAudioDevices().then(setDevices, () => undefined);
  }, [active]);
  return (
    <div className="desk-audio">
      <button
        type="button"
        className={`button ${muted ? 'danger' : ''}`}
        aria-pressed={muted}
        onClick={() => onMute(!muted)}
      >
        {muted ? 'Unmute' : 'Mute'}
      </button>
      <div className="field">
        <label htmlFor="desk-volume">Caller volume</label>
        <input
          id="desk-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(event) => onVolume(Number(event.target.value))}
        />
      </div>
      <div className="field">
        <label htmlFor="desk-input">Microphone</label>
        <Select
          id="desk-input"
          value={input}
          placeholder="System default"
          options={devices.inputs.map((device) => ({ value: device.id, label: device.label }))}
          onChange={(next) => {
            setInput(next);
            if (next) onInput(next);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="desk-output">Speaker</label>
        <Select
          id="desk-output"
          value={output}
          placeholder="System default"
          options={devices.outputs.map((device) => ({ value: device.id, label: device.label }))}
          onChange={(next) => {
            setOutput(next);
            if (next) onOutput(next);
          }}
        />
      </div>
      <div className="desk-levels">
        <span className="muted">You</span>
        <LevelMeter label="Your level" level={() => levels().input} active={active && !muted} />
        <span className="muted">Caller</span>
        <LevelMeter label="Caller level" level={() => levels().output} active={active} />
      </div>
    </div>
  );
}
