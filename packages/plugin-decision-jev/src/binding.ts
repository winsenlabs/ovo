import { validateProviderEndpoint } from '@winsendotai/ovo-plugin-kit';
import { JEV_ENDPOINT, JEV_HOST, JEV_PATH } from './wire.ts';

export class JevBindingError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'JevBindingError';
  }
}

/** The non-secret row config. Every field has a documented default except `calibrationLabel`. */
export interface JevBinding {
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  calibrationLabel?: string;
  maxQuestionsPerRequest?: number;
}

export interface ResolvedJevBinding {
  model: string;
  endpoint: string;
  timeoutMs: number;
  calibrationLabel: string;
  maxQuestionsPerRequest: number;
}

export const DEFAULT_MODEL = 'jev-latest';
export const DEFAULT_TIMEOUT_MS = 2000;
export const MIN_TIMEOUT_MS = 200;
export const MAX_TIMEOUT_MS = 10_000;
/** The published `maxQuestionsPerRequest` is unstated; this is the operator-overridable default. */
export const DEFAULT_MAX_QUESTIONS = 16;

/**
 * `calibrationLabel` is REQUIRED and has no default. It is half of every answer's
 * `calibrationVersion`, so a default would hand a release a calibration identity nobody chose —
 * exactly the fabrication `DecisionAnswer.calibrationVersion` exists to prevent. A binding without
 * it is refused at `apply`, before any request is built.
 */
export function resolveBinding(raw: unknown): ResolvedJevBinding {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw)))
    throw new JevBindingError('Jev binding must be an object');
  const binding = (raw ?? {}) as JevBinding;

  const label = binding.calibrationLabel;
  if (typeof label !== 'string' || !label.trim())
    throw new JevBindingError(
      'Jev binding requires a non-empty calibrationLabel; it names the cohort every answer’s ' +
        'calibrationVersion reports and this plugin will not invent one',
    );

  const model = binding.model ?? DEFAULT_MODEL;
  if (typeof model !== 'string' || !model.trim())
    throw new JevBindingError('Jev binding model must be a non-empty string');

  const timeoutMs = binding.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS)
    throw new JevBindingError(
      `Jev binding timeoutMs must be an integer in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`,
    );

  const maxQuestions = binding.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS;
  if (!Number.isSafeInteger(maxQuestions) || maxQuestions < 1)
    throw new JevBindingError('Jev binding maxQuestionsPerRequest must be a positive integer');

  // Validated against the one host the manifest declares, so a binding cannot redirect egress.
  const endpoint = binding.endpoint ?? JEV_ENDPOINT;
  if (typeof endpoint !== 'string')
    throw new JevBindingError('Jev binding endpoint must be a string');
  let url: URL;
  try {
    url = validateProviderEndpoint(endpoint, JEV_PATH, JEV_HOST);
  } catch (error) {
    throw new JevBindingError(
      `Jev binding endpoint is not usable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    model: model.trim(),
    endpoint: url.href,
    timeoutMs,
    calibrationLabel: label.trim(),
    maxQuestionsPerRequest: maxQuestions,
  };
}
