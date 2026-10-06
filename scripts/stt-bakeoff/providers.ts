// The three bake-off contestants, built from the production plugins with telephony bindings.
import type { Clock, NetPort, SpeechToText } from '../../packages/contracts/src/index.ts';
import { AssemblyAiStt } from '../../packages/plugin-stt-assemblyai/src/provider.ts';
import { ElevenLabsStt } from '../../packages/plugin-stt-elevenlabs/src/provider.ts';
import { SarvamStt } from '../../packages/plugin-speech-sarvam/src/stt.ts';
import type { ProviderId } from './types.ts';

export interface Contestant {
  /** The environment variable holding the API key for live mode. Never read otherwise. */
  keyEnv: string;
  model: string;
  /** The host commits the turn after local silence (Scribe's manual strategy); others endpoint. */
  commits: boolean;
  create(net: NetPort, key: string, clock?: Clock): SpeechToText;
}

/**
 * Each provider as the collections agent would bind it: Scribe v2 realtime with manual commit and
 * language auto-detect (POC parity), AssemblyAI's code-switching pro model with the `fast` preset,
 * and Sarvam Saaras in code-mix mode. Change a binding here to bake off another configuration.
 */
export const CONTESTANTS: Readonly<Record<ProviderId, Contestant>> = {
  scribe: {
    keyEnv: 'OVO_BAKEOFF_ELEVENLABS_API_KEY',
    model: 'scribe_v2_realtime',
    commits: true,
    create: (net, key, clock) =>
      new ElevenLabsStt(net, key, { commitStrategy: 'manual', languageMode: 'auto' }, clock),
  },
  assemblyai: {
    keyEnv: 'OVO_BAKEOFF_ASSEMBLYAI_API_KEY',
    model: 'universal-3-6-pro',
    commits: false,
    create: (net, key, clock) =>
      new AssemblyAiStt(
        net,
        key,
        { model: 'universal-3-6-pro', region: 'us', endpointing: 'fast' },
        clock,
      ),
  },
  sarvam: {
    keyEnv: 'OVO_BAKEOFF_SARVAM_API_KEY',
    model: 'saaras:v3-realtime',
    commits: false,
    create: (net, key, clock) => new SarvamStt(net, key, { mode: 'codemix' }, clock),
  },
};
