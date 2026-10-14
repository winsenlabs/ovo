// The shape of a bake-off contestant: a provider configuration built from OVO's production plugin.
import type { NetPort, SpeechToText } from '../../../contracts/src/index.ts';

/** The provider key names in `~/.ovo-eval/keys.env` (or `OVO_EVAL_<name>` in the environment). */
export type KeyName =
  | 'ELEVENLABS_API_KEY'
  | 'ASSEMBLYAI_API_KEY'
  | 'DEEPGRAM_API_KEY'
  | 'SARVAM_API_KEY'
  | 'CARTESIA_API_KEY'
  | 'OPENAI_API_KEY';

export interface Price {
  /** List price per hour of what the basis counts. */
  usdPerHour: number;
  /** `audio`: seconds of audio sent; `session`: socket open to close (AssemblyAI streaming). */
  basis: 'audio' | 'session';
  source: string;
  retrieved: string;
  note?: string;
}

export interface SttConfig {
  id: string;
  label: string;
  provider: 'elevenlabs' | 'assemblyai' | 'deepgram' | 'sarvam' | 'cartesia' | 'openai';
  model: string;
  key: KeyName;
  /** The session language the agent passes. */
  language: string;
  /** The options that differ from the plugin defaults, as a reader would set them. */
  binding: string;
  /** The live call's own configuration (Maya, release c3ed1be8). */
  production?: boolean;
  /** Absent while OVO has no plugin for the provider on main. */
  create?: (net: NetPort, key: string) => SpeechToText;
  price: Price;
  /** Where the options were confirmed, and when. */
  docs: { url: string; retrieved: string; confirmed: string }[];
}

export type ConfigStatus = 'ready' | 'pending key' | 'pending plugin';
