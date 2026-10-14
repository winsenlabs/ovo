// The STT configurations an audio replay can stream a call through, each built from OVO's own
// production plugin with a telephony binding. A configuration whose key is not in the keys file is
// `pending key`; one whose plugin is not on this branch (Cartesia Ink-2, Wave 11) is `unavailable`
// and is listed so the runner names it. Keys are read from the keys file into this process only:
// never printed, logged or passed on a command line.
import { readFile } from 'node:fs/promises';
import type { Clock, NetPort, SpeechToText } from '@winsendotai/ovo-contracts';
import { SarvamStt } from '@winsendotai/ovo-plugin-speech-sarvam';
import { AssemblyAiStt } from '@winsendotai/ovo-plugin-stt-assemblyai';
import { DeepgramStt } from '@winsendotai/ovo-plugin-stt-deepgram';
import { ElevenLabsStt } from '@winsendotai/ovo-plugin-stt-elevenlabs';
import { OpenAiRealtimeStt } from '@winsendotai/ovo-plugin-stt-openai-realtime';

export interface SttConfig {
  id: string;
  provider: string;
  description: string;
  /** The keys-file variable holding the provider's API key. */
  keyEnv: string;
  create?: (net: NetPort, key: string, clock?: Clock) => SpeechToText;
}

/** Terms the Maya calls misheard: the agent's and caller's names, the European places asked about. */
export const MAYA_KEYTERMS = [
  'Maya',
  'Tejas',
  'Zagreb',
  'Budapest',
  'Vienna',
  'Prague',
  'Croatia',
  'Dubrovnik',
  'Berlin',
  'Brandenburg Gate',
  'Frankfurt',
  'Chennai',
  'Balkans',
];

const scribe =
  (binding: ConstructorParameters<typeof ElevenLabsStt>[2]) =>
  (net: NetPort, key: string, clock?: Clock) =>
    new ElevenLabsStt(net, key, { commitStrategy: 'manual', ...binding }, clock, {
      agentName: 'Maya',
    });

export const STT_CONFIGS: readonly SttConfig[] = [
  {
    id: 'scribe-auto',
    provider: 'elevenlabs',
    description: 'Scribe v2 realtime, manual commit, language auto-detect (production)',
    keyEnv: 'ELEVENLABS_API_KEY',
    create: scribe({ languageMode: 'auto' }),
  },
  {
    id: 'scribe-en',
    provider: 'elevenlabs',
    description: 'Scribe v2 realtime pinned to English',
    keyEnv: 'ELEVENLABS_API_KEY',
    create: scribe({ languageMode: 'session', sessionLanguage: 'en' }),
  },
  {
    id: 'scribe-hi',
    provider: 'elevenlabs',
    description: 'Scribe v2 realtime pinned to Hindi',
    keyEnv: 'ELEVENLABS_API_KEY',
    create: scribe({ languageMode: 'session', sessionLanguage: 'hi' }),
  },
  {
    id: 'scribe-en-keyterms',
    provider: 'elevenlabs',
    description: 'Scribe v2 realtime pinned to English, Hindi secondary, Maya keyterms',
    keyEnv: 'ELEVENLABS_API_KEY',
    create: scribe({
      languageMode: 'session',
      sessionLanguage: 'en',
      secondaryLanguages: ['hi'],
      keyterms: MAYA_KEYTERMS,
    }),
  },
  {
    id: 'assemblyai-en',
    provider: 'assemblyai',
    description: 'AssemblyAI universal-streaming English',
    keyEnv: 'ASSEMBLYAI_API_KEY',
    create: (net, key, clock) =>
      new AssemblyAiStt(net, key, { model: 'universal-streaming-english' }, clock),
  },
  {
    id: 'assemblyai-multi',
    provider: 'assemblyai',
    description: 'AssemblyAI universal-streaming multilingual',
    keyEnv: 'ASSEMBLYAI_API_KEY',
    create: (net, key, clock) =>
      new AssemblyAiStt(net, key, { model: 'universal-streaming-multilingual' }, clock),
  },
  {
    id: 'deepgram-nova3-multi',
    provider: 'deepgram',
    description: 'Deepgram Nova-3, multilingual code-switching',
    keyEnv: 'DEEPGRAM_API_KEY',
    create: (net, key, clock) =>
      new DeepgramStt(net, key, { model: 'nova-3', language: 'multi' }, clock),
  },
  {
    id: 'deepgram-nova3-en-in',
    provider: 'deepgram',
    description: 'Deepgram Nova-3, Indian English',
    keyEnv: 'DEEPGRAM_API_KEY',
    create: (net, key, clock) =>
      new DeepgramStt(net, key, { model: 'nova-3', language: 'en-IN' }, clock),
  },
  {
    id: 'sarvam-saaras-codemix',
    provider: 'sarvam',
    description: 'Sarvam Saaras v3 realtime, code-mix',
    keyEnv: 'SARVAM_API_KEY',
    create: (net, key, clock) => new SarvamStt(net, key, { mode: 'codemix' }, clock),
  },
  {
    id: 'openai-realtime',
    provider: 'openai',
    description: 'OpenAI realtime transcription, manual commit',
    keyEnv: 'OVO_EVAL_OPENAI_API_KEY',
    create: (net, key, clock) => new OpenAiRealtimeStt(net, key, {}, clock),
  },
  {
    id: 'cartesia-ink2',
    provider: 'cartesia',
    description: 'Cartesia Ink-2 (plugin in Wave 11, not merged: add its create here once it is)',
    keyEnv: 'CARTESIA_API_KEY',
  },
];

/** `KEY=value` lines (a shell env file); comments and blank lines skipped, quotes stripped. */
export function parseKeysFile(text: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    keys[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return keys;
}

export async function readKeys(path: string): Promise<Record<string, string>> {
  return parseKeysFile(await readFile(path, 'utf8'));
}

export type SttStatus = 'ready' | 'pending key' | 'unavailable';

export function sttStatus(config: SttConfig, keys: Readonly<Record<string, string>>): SttStatus {
  if (!config.create) return 'unavailable';
  return keys[config.keyEnv] ? 'ready' : 'pending key';
}

export function sttConfig(id: string): SttConfig {
  const config = STT_CONFIGS.find((entry) => entry.id === id);
  if (!config)
    throw new Error(`unknown STT config ${id}: one of ${STT_CONFIGS.map((c) => c.id).join(', ')}`);
  return config;
}
