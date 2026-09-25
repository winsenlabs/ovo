import {
  MULAW_8K,
  PCM16_16K,
  PCM16_8K,
  sameFormat,
  type Clock,
  type NetPort,
  type SpeechToText,
} from '@winsendotai/ovo-contracts';
import { systemClock } from '@winsendotai/ovo-plugin-kit';
import { AssemblyAiSession } from './session.ts';

export interface AssemblyAiBinding {
  model?: 'universal-streaming-english' | 'universal-streaming-multilingual' | 'universal-3-5-pro';
  region?: 'default' | 'us' | 'eu';
  minTurnSilenceMs?: number;
  maxTurnSilenceMs?: number;
  endOfTurnConfidenceThreshold?: number;
  keyterms?: readonly string[];
}

export const ASSEMBLYAI_CAPABILITIES = Object.freeze({
  inputFormats: [MULAW_8K, PCM16_16K, PCM16_8K],
  frameMs: { min: 50, max: 1000, preferred: 100 },
  // Host compat compares the full release language; en-IN is AgentConfig's default.
  languages: ['en', 'en-IN'],
  interim: true,
  wordTimestamps: true,
  turnSignals: ['speech-start', 'end-of-turn'] as const,
  forceEndpoint: true,
  ttfsP99Ms: 420,
});

const MULTILINGUAL_LANGUAGES = ['en', 'es', 'de', 'fr', 'pt', 'it'];
const PRO_LANGUAGES = [
  'ar',
  'ca',
  'da',
  'nl',
  'en',
  'fi',
  'fr',
  'de',
  'he',
  'hi',
  'it',
  'ja',
  'zh',
  'no',
  'pt',
  'es',
  'sv',
  'tr',
  'vi',
];

function languagesFor(model: AssemblyAiBinding['model']): readonly string[] {
  if (model === 'universal-streaming-multilingual') return MULTILINGUAL_LANGUAGES;
  if (model === 'universal-3-5-pro') return PRO_LANGUAGES;
  return ['en'];
}

export function assemblyAiUrl(
  binding: AssemblyAiBinding,
  format: Parameters<SpeechToText['start']>[0]['format'],
): string {
  const host =
    binding.region === 'us'
      ? 'streaming.us.assemblyai.com'
      : binding.region === 'eu'
        ? 'streaming.eu.assemblyai.com'
        : 'streaming.assemblyai.com';
  const url = new URL(`wss://${host}/v3/ws`);
  url.searchParams.set('speech_model', binding.model ?? 'universal-streaming-english');
  url.searchParams.set('sample_rate', String(format.sampleRate));
  url.searchParams.set('encoding', format.encoding === 'mulaw' ? 'pcm_mulaw' : 'pcm_s16le');
  url.searchParams.set('format_turns', 'false');
  if (binding.minTurnSilenceMs !== undefined)
    url.searchParams.set('min_turn_silence', String(binding.minTurnSilenceMs));
  if (binding.maxTurnSilenceMs !== undefined)
    url.searchParams.set('max_turn_silence', String(binding.maxTurnSilenceMs));
  if (binding.endOfTurnConfidenceThreshold !== undefined)
    url.searchParams.set(
      'end_of_turn_confidence_threshold',
      String(binding.endOfTurnConfidenceThreshold),
    );
  if (binding.keyterms?.length)
    url.searchParams.set('keyterms_prompt', JSON.stringify(binding.keyterms));
  return url.toString();
}

export class AssemblyAiStt implements SpeechToText {
  readonly capabilities;
  readonly binding: Readonly<AssemblyAiBinding>;

  constructor(
    private readonly net: NetPort,
    private readonly key: string,
    binding: AssemblyAiBinding = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    this.capabilities = { ...ASSEMBLYAI_CAPABILITIES, languages: languagesFor(binding.model) };
  }

  async start(input: Parameters<SpeechToText['start']>[0]): Promise<AssemblyAiSession> {
    if (!this.capabilities.inputFormats.some((format) => sameFormat(format, input.format)))
      throw new TypeError('AssemblyAI requires a native PCM or mu-law format');
    if (!this.capabilities.languages.includes(input.language.split('-')[0]!.toLowerCase()))
      throw new TypeError(
        `AssemblyAI model ${this.binding.model ?? 'universal-streaming-english'} does not support ${input.language}`,
      );
    input.signal.throwIfAborted();
    const socket = this.net.websocket(assemblyAiUrl(this.binding, input.format), {
      headers: { Authorization: this.key },
    });
    const session = new AssemblyAiSession(socket, input, this.binding, this.clock);
    await session.ready;
    return session;
  }
}
