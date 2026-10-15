import type { AudioFormat, SttConfigurationUpdate } from '@winsendotai/ovo-contracts';
import {
  AUTO_PATH,
  CARTESIA_HOST,
  CARTESIA_VERSION,
  MANUAL_PATH,
  encodingOf,
  query,
} from './wire.ts';

/** ink-2: en, fr, hi, ja, es, detected automatically, no language parameter (stt/latest.md). */
export const INK2_LANGUAGES: readonly string[] = Object.freeze('en fr hi ja es'.split(' '));
/** ink-whisper-2025-06-04's languages (stt/older-models.md, retrieved 2026-10-13). */
export const WHISPER_LANGUAGES: readonly string[] = Object.freeze(
  (
    'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no ' +
    'th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw ' +
    'gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl ' +
    'mg as tt haw ln ha ba jw su yue'
  ).split(' '),
);

export type Endpointing = 'fast' | 'balanced' | 'patient';
export interface TurnSettings {
  startThreshold: number;
  eagerEndThreshold: number;
  endThreshold: number;
  endTimeoutMs: number;
}

/**
 * OVO's endpointing presets as Cartesia's documented profiles: fast is "Responsive", balanced the
 * default, patient "Patient" (https://docs.cartesia.ai/use-the-api/stt/turns.md, 2026-10-13).
 */
export const ENDPOINTING: Readonly<Record<Endpointing, TurnSettings>> = Object.freeze({
  fast: { startThreshold: 0.7, eagerEndThreshold: 0.6, endThreshold: 0.4, endTimeoutMs: 4500 },
  balanced: { startThreshold: 0.8, eagerEndThreshold: 0.6, endThreshold: 0.3, endTimeoutMs: 5600 },
  patient: { startThreshold: 0.8, eagerEndThreshold: 0.3, endThreshold: 0.1, endTimeoutMs: 8000 },
});

/** Documented ranges of the `turn_*` parameters and the config command. */
export const TURN_RANGES = Object.freeze({
  startThreshold: [0.5, 0.9],
  eagerEndThreshold: [0.3, 0.8],
  endThreshold: [0.05, 0.5],
  endTimeoutMs: [640, 11_200],
} as const);

/** "up to 100 keyterms totaling 1200 characters" (use-the-api/stt/keyterms.md). */
export const MAX_KEYTERMS = 100;
export const MAX_KEYTERM_CHARS = 1_200;
export const DEFAULT_CONNECT_TIMEOUT_MS = 6_000;
export const DEFAULT_BACKLOG_MAX_RATE = 2;

interface Shared {
  /** Connect-time only: "You cannot add or change keyterms mid-stream". ink-2 only. */
  keyterms?: readonly string[];
  connectTimeoutMs?: number;
  /** The pre-session replay goes out at most this many times real time. */
  backlogMaxRate?: number;
}

export interface CartesiaAutoBinding extends Shared {
  model?: 'ink-2';
  endpointing?: Endpointing;
  turnStartThreshold?: number;
  turnEagerEndThreshold?: number;
  turnEndThreshold?: number;
  turnEndTimeoutMs?: number;
}

export interface CartesiaManualBinding extends Shared {
  model?: 'ink-2' | 'ink-whisper';
  /**
   * ISO 639-1, ink-whisper only. ink-whisper does no detection, so each connection names the
   * session's language when ink-whisper lists it (the language the compat check approved); this is
   * sent only for a session whose language it does not list. ink-2 detects the language itself.
   */
  language?: string;
  /** ink-whisper only: what counts as silence for its automatic finalization, 0–1. */
  minVolume?: number;
  /** ink-whisper only: silence before it finalizes on its own. */
  maxSilenceDurationSecs?: number;
}

/** The binding's turn settings, or undefined when it sets none (the provider's Balanced). */
export function connectTurn(binding: Readonly<CartesiaAutoBinding>): TurnSettings | undefined {
  const explicit = {
    ...(binding.turnStartThreshold === undefined
      ? {}
      : { startThreshold: binding.turnStartThreshold }),
    ...(binding.turnEagerEndThreshold === undefined
      ? {}
      : { eagerEndThreshold: binding.turnEagerEndThreshold }),
    ...(binding.turnEndThreshold === undefined ? {} : { endThreshold: binding.turnEndThreshold }),
    ...(binding.turnEndTimeoutMs === undefined ? {} : { endTimeoutMs: binding.turnEndTimeoutMs }),
  };
  if (!binding.endpointing && !Object.keys(explicit).length) return undefined;
  return { ...ENDPOINTING[binding.endpointing ?? 'balanced'], ...explicit };
}

/** Ranges and the documented order start > eager_end > end; a TypeError names what is wrong. */
export function checkTurn(settings: TurnSettings): TurnSettings {
  for (const [field, [low, high]] of Object.entries(TURN_RANGES)) {
    const value = settings[field as keyof TurnSettings];
    if (!(value >= low && value <= high))
      throw new TypeError(`Cartesia turn ${field} ${value} is outside ${low}–${high}`);
  }
  if (!(settings.startThreshold > settings.eagerEndThreshold))
    throw new TypeError('Cartesia turn start threshold must stay above the eager end threshold');
  if (!(settings.eagerEndThreshold > settings.endThreshold))
    throw new TypeError('Cartesia turn eager end threshold must stay above the end threshold');
  return settings;
}

/**
 * A mid-call update applied to the current settings: a preset replaces them, `maxTurnSilenceMs`
 * becomes `end_timeout_ms` (clamped to its range). `endOfTurnConfidenceThreshold` is not mapped:
 * Cartesia ends a turn when its likelihood falls *below* `end_threshold`, the opposite sense, and
 * the conversion is UNCONFIRMED. Other fields have no Cartesia equivalent.
 */
export function applyUpdate(current: TurnSettings, update: SttConfigurationUpdate): TurnSettings {
  const next = { ...(update.endpointing ? ENDPOINTING[update.endpointing] : current) };
  if (update.maxTurnSilenceMs !== undefined) {
    const [low, high] = TURN_RANGES.endTimeoutMs;
    next.endTimeoutMs = Math.round(Math.min(high, Math.max(low, update.maxTurnSilenceMs)));
  }
  return checkTurn(next);
}

/**
 * The connection's keyterms: the binding's (which must fit the limits on their own), then the
 * agent's while they fit, case-insensitively de-duplicated.
 */
export function callKeyterms(
  binding: readonly string[] | undefined,
  agent: readonly string[] | undefined,
): string[] {
  const own = (binding ?? []).map((term) => term.trim()).filter(Boolean);
  const total = own.reduce((sum, term) => sum + term.length, 0);
  if (own.length > MAX_KEYTERMS || total > MAX_KEYTERM_CHARS)
    throw new TypeError(
      `Cartesia keyterms allow ${MAX_KEYTERMS} terms of ${MAX_KEYTERM_CHARS} characters in total`,
    );
  const seen = new Set<string>();
  const out: string[] = [];
  let chars = 0;
  for (const term of [...own, ...(agent ?? []).map((value) => value.trim())]) {
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    if (out.length >= MAX_KEYTERMS || chars + term.length > MAX_KEYTERM_CHARS) continue;
    seen.add(key);
    out.push(term);
    chars += term.length;
  }
  return out;
}

function base(format: AudioFormat, model: string): [string, string | number][] {
  return [
    ['model', model],
    ['encoding', encodingOf(format)],
    ['sample_rate', format.sampleRate],
    ['cartesia_version', CARTESIA_VERSION],
  ];
}

export function autoUrl(
  binding: Readonly<CartesiaAutoBinding>,
  format: AudioFormat,
  keyterms: readonly string[],
): string {
  const turn = connectTurn(binding);
  const params = base(format, 'ink-2');
  if (turn)
    params.push(
      ['turn_start_threshold', turn.startThreshold],
      ['turn_eager_end_threshold', turn.eagerEndThreshold],
      ['turn_end_threshold', turn.endThreshold],
      ['turn_end_timeout_ms', turn.endTimeoutMs],
    );
  for (const term of keyterms) params.push(['keyterm', term]);
  return `wss://${CARTESIA_HOST}${AUTO_PATH}?${query(params)}`;
}

/** `language` is the ink-whisper connection's (see `whisperLanguage`); ink-2 sends none. */
export function manualUrl(
  binding: Readonly<CartesiaManualBinding>,
  format: AudioFormat,
  keyterms: readonly string[],
  language?: string,
): string {
  const model = binding.model ?? 'ink-2';
  const params = base(format, model);
  if (model === 'ink-whisper') {
    if (!language) throw new TypeError('Cartesia ink-whisper needs a language for the connection');
    params.push(['language', language]);
    if (binding.minVolume !== undefined) params.push(['min_volume', binding.minVolume]);
    if (binding.maxSilenceDurationSecs !== undefined)
      params.push(['max_silence_duration_secs', binding.maxSilenceDurationSecs]);
  } else for (const term of keyterms) params.push(['keyterm', term]);
  return `wss://${CARTESIA_HOST}${MANUAL_PATH}?${query(params)}`;
}

/** The manual binding's model rules, checked again where the schema cannot reach (factory use). */
export function checkManual(binding: Readonly<CartesiaManualBinding>): void {
  const whisper = binding.model === 'ink-whisper';
  if (whisper && binding.language !== undefined && !WHISPER_LANGUAGES.includes(binding.language))
    throw new TypeError(`Cartesia ink-whisper does not transcribe ${binding.language}`);
  if (whisper && binding.keyterms?.length)
    throw new TypeError('Cartesia keyterms are for ink-2 only');
  if (
    !whisper &&
    (binding.language ||
      binding.minVolume !== undefined ||
      binding.maxSilenceDurationSecs !== undefined)
  )
    throw new TypeError(
      'Cartesia language, minVolume and maxSilenceDurationSecs are ink-whisper only',
    );
}

export const baseLanguage = (language: string) => language.split(/[-_]/)[0]!.toLowerCase();

/**
 * The language an ink-whisper connection transcribes: the session's base language when ink-whisper
 * lists it, else the binding's. A TypeError when neither applies, since any other language would
 * be heard as the wrong one.
 */
export function whisperLanguage(
  binding: Readonly<CartesiaManualBinding>,
  sessionLanguage: string,
): string {
  const session = baseLanguage(sessionLanguage);
  if (WHISPER_LANGUAGES.includes(session)) return session;
  if (binding.language) return binding.language;
  throw new TypeError(`Cartesia ink-whisper does not transcribe ${sessionLanguage}`);
}
