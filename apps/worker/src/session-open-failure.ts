import { timeoutOf, type EndReason } from '@winsendotai/ovo-contracts';
import { redactLogText } from '@winsendotai/ovo-plugin-kit';
import { pluginFailureOf } from '@winsendotai/ovo-runtime';

/**
 * Where a session open failed: the durable route check, the owned job, admission (cost or
 * inbound capacity), engine composition (STT, TTS, graph), or the durable opened record.
 */
export type SessionOpenStage = 'route' | 'job' | 'admission' | 'compose' | 'record';

/**
 * The provider behind a session-open failure: the plugin whose start threw (recorded by the
 * runtime), else the first error in the cause chain that names its `provider` (and `kind`).
 */
export function sessionOpenSource(error: unknown): {
  provider?: string;
  providerKind?: string;
  pluginId?: string;
} {
  const started = pluginFailureOf(error);
  if (started)
    return {
      pluginId: started.pluginId,
      ...(started.provider ? { provider: started.provider } : {}),
      ...(started.kind ? { providerKind: started.kind } : {}),
    };
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    const { provider, kind, cause } = current as {
      provider?: unknown;
      kind?: unknown;
      cause?: unknown;
    };
    if (typeof provider === 'string' && provider)
      return { provider, ...(typeof kind === 'string' && kind ? { providerKind: kind } : {}) };
    current = cause;
  }
  return {};
}

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

/** True when the error or a cause is a timeout by name or code, whatever its message says. */
export function sessionOpenTimedOut(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    const { name, code, cause } = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (name === 'TimeoutError' || (typeof code === 'string' && TIMEOUT_CODES.has(code)))
      return true;
    current = cause;
  }
  return false;
}

/**
 * `error:session-open-failed:<stage>:[<kind>/]<provider>: <message>` when the provider is known,
 * else `error:session-open-failed:<stage>:<message>`; scrubbed of credentials and kept short. A
 * timeout whose message does not say so reads `…: timeout: <message>`, so `timeoutOf` names the
 * stage and provider that timed out (OBS-9).
 */
export function sessionOpenFailure(stage: SessionOpenStage, error: unknown): EndReason {
  const message = redactLogText(error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const { provider, providerKind } = sessionOpenSource(error);
  const source = provider ? `${providerKind ? `${providerKind}/` : ''}${provider}: ` : '';
  const reason: EndReason = `error:session-open-failed:${stage}:${source}${message}`;
  return sessionOpenTimedOut(error) && !timeoutOf(reason)
    ? `error:session-open-failed:${stage}:${source}timeout: ${message}`
    : reason;
}
