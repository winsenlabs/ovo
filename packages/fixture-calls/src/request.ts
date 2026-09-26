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

export function fixtureCallsEnabled(input: { enabled?: boolean; nodeEnv?: string }): boolean {
  return input.enabled ?? input.nodeEnv !== 'production';
}

export function fixtureCallsEnvironmentEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('OVO_FIXTURE_TEST_CALLS must be true or false');
}

export function idempotentFixtureCallId(workspaceId: string, agentId: string, key: string): string {
  const bytes = createHash('sha256').update(`${workspaceId}\0${agentId}\0${key}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
