import { plan } from '@winsendotai/ovo-audio';
import type {
  AudioFormat,
  CarrierCapabilities,
  EngineCapabilities,
  SpeechCapabilities,
} from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const formatUnreachable: CompatRule = (input, stage) => {
  const defs = Object.fromEntries(
    resolved(input).map((entry) => [entry.slot, manifestKeys(entry.definition.manifest).manifest]),
  );
  const carrier = (defs.carrier?.capabilities as CarrierCapabilities | undefined)?.media.formats;
  const engine = (defs.engine?.capabilities as EngineCapabilities | undefined)?.formats;
  const stt = (defs.stt?.capabilities as SpeechCapabilities | undefined)?.inputFormats;
  const tts = (defs.tts?.capabilities as SpeechCapabilities | undefined)?.outputFormats;
  if (!carrier?.length || !engine?.length) return [];
  const pairs = carrier.some((from: AudioFormat) => engine.some((to) => plan(from, to)));
  const inputPath =
    !stt?.length || carrier.some((from: AudioFormat) => stt.some((to) => plan(from, to)));
  const outputPath =
    !tts?.length || tts.some((from) => carrier.some((to: AudioFormat) => plan(from, to)));
  return pairs && inputPath && outputPath
    ? []
    : [
        issue(
          'format_unreachable',
          stage,
          'No audio codec path connects the selected carrier, engine and speech providers',
        ),
      ];
};
