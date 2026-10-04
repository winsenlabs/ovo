import { withEgressSentinel, type EgressSentinel } from '@winsendotai/ovo-conformance/drivers';

/** Wrap child setup as well as the call, so process-plugin apply cannot reach external sockets. */
export function withFixtureEgressSentinel<T>(
  run: (sentinel: EgressSentinel) => Promise<T> | T,
): Promise<T> {
  return withEgressSentinel(run, { allowLoopback: false });
}
