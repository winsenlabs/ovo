import type { SessionRoute } from '@winsendotai/ovo-plugin-orchestration';

/** A carrier completion is successful only after a worker claimed the media session. */
export function completedWithoutSession(
  state: string,
  route: Pick<SessionRoute, 'handshakeClaimedAt'> | undefined,
): boolean {
  return state === 'completed' && !route?.handshakeClaimedAt;
}
