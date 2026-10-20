/** Microphone access for the desk's "Test microphone" step (design 8.1): permission, devices, level. */

export type MicrophoneFailure = 'denied' | 'not_found' | 'in_use' | 'unsupported';

export class MicrophoneError extends Error {
  constructor(public readonly reason: MicrophoneFailure) {
    super(`Microphone unavailable: ${reason}`);
  }
}

export interface AudioDevice {
  id: string;
  label: string;
}

export interface AudioDevices {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
}

/** The browser surface used here, injectable so tests need no media stack. */
export interface MediaAccess {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

function browserMedia(): MediaAccess {
  const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!devices?.getUserMedia) throw new MicrophoneError('unsupported');
  return devices;
}

/** Maps the browser's `DOMException` names onto the four states the UI has copy for. */
export function classifyMicrophoneFailure(error: unknown): MicrophoneFailure {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'not_found';
  if (name === 'NotReadableError' || name === 'AbortError') return 'in_use';
  return 'unsupported';
}

export async function listAudioDevices(media: MediaAccess = browserMedia()): Promise<AudioDevices> {
  const all = await media.enumerateDevices();
  const pick = (kind: MediaDeviceKind, fallback: string): AudioDevice[] =>
    all
      .filter((device) => device.kind === kind && device.deviceId)
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `${fallback} ${index + 1}`,
      }));
  return { inputs: pick('audioinput', 'Microphone'), outputs: pick('audiooutput', 'Speaker') };
}

export interface MicrophoneProbe {
  /** Current input level, 0 to 1 (RMS of the latest analyser frame). */
  level(): number;
  /** Releases the microphone; the desk keeps none open outside a call. */
  stop(): void;
}

/**
 * Asks for the microphone (the permission prompt is the point) and exposes a level meter. Throws
 * `MicrophoneError` with a reason the UI maps to copy; the stream is always released by `stop`.
 */
export async function probeMicrophone(
  deviceId?: string,
  media: MediaAccess = browserMedia(),
): Promise<MicrophoneProbe> {
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
  } catch (error) {
    throw new MicrophoneError(classifyMicrophoneFailure(error));
  }
  const stop = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  const Context =
    typeof AudioContext === 'undefined'
      ? undefined
      : (AudioContext as typeof AudioContext | undefined);
  if (!Context) return { level: () => 0, stop };
  const context = new Context();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return {
    level() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    },
    stop() {
      stop();
      void context.close().catch(() => undefined);
    },
  };
}
