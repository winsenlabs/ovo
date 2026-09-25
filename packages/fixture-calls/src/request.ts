import { createHash } from 'node:crypto';
import type { CallerScript } from './types.ts';

export function callerScriptFitsWallTimeout(script: CallerScript, wallTimeoutMs: number): boolean {
  const lastTurnMs = Math.max(0, ...script.turns.map((turn) => turn.atMs + (turn.silenceMs ?? 0)));
  return lastTurnMs + 5_000 < wallTimeoutMs - 5_000;
}

export function fixtureRequestFingerprint(body: {
  useDraft: boolean;
  releaseId?: string;
  callerScript?: CallerScript | 'default';
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        useDraft: body.useDraft,
        releaseId: body.releaseId ?? 'latest',
        callerScript: body.callerScript ?? 'default',
      }),
    )
    .digest('hex');
}
