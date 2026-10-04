import type { SpeechCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const sttFrameSize: CompatRule = (input, stage) => {
  const stt = resolved(input).find((entry) => entry.slot === 'stt');
  const frame = (
    stt && (manifestKeys(stt.definition.manifest).manifest.capabilities as SpeechCapabilities)
  )?.frameMs;
  return stt && frame && input.carrierFrameMs && frame.min > input.carrierFrameMs
    ? [
        issue(
          'stt_frame_size',
          stage,
          `STT requires at least ${frame.min} ms frames; the host will aggregate carrier frames`,
          { slot: 'stt', pluginId: stt.choice.pluginId },
          'warning',
        ),
      ]
    : [];
};
