'use client';
import { useEffect, useState } from 'react';
import { queuesApi } from '../../lib/data/queues-api';
import type { ContextPolicy, PreviewResult, WebhookSpec } from '../../lib/types/queues';

export type MappingPreview =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; result: PreviewResult }
  | { status: 'error'; message: string };

/**
 * The rendered body (or the mapping's issues) for the spec being edited, from the API's pure
 * preview. Debounced so typing does not post on every key, and a stale answer never overwrites a
 * newer one. The preview is rendered server-side against synthetic data: no call, no network.
 */
export function useMappingPreview(
  spec: WebhookSpec,
  policy: ContextPolicy,
  enabled: boolean,
  delayMs = 400,
): MappingPreview {
  const [state, setState] = useState<MappingPreview>({ status: 'idle' });
  const key = JSON.stringify([spec.body, spec.format, policy]);
  useEffect(() => {
    if (!enabled) return setState({ status: 'idle' });
    let current = true;
    setState({ status: 'loading' });
    const timer = setTimeout(() => {
      queuesApi.preview({ ...spec }, policy).then(
        (result) => current && setState({ status: 'ready', result }),
        (failure: unknown) =>
          current &&
          setState({
            status: 'error',
            message: failure instanceof Error ? failure.message : 'The preview failed.',
          }),
      );
    }, delayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // The spec's body, format and the policy are the only inputs; `spec` is a fresh object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, delayMs]);
  return state;
}
