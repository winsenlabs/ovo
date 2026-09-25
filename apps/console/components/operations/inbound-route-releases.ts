'use client';
import { useEffect, useState } from 'react';
import { apiRequest, type Release } from '../../lib/api';
import type { ReleaseOption } from './agent-release-options';

export function useBoundRouteRelease(releaseId: string | undefined, listed: boolean) {
  const [result, setResult] = useState<{
    id: string;
    release?: ReleaseOption;
    error?: string;
  }>();
  useEffect(() => {
    if (!releaseId || listed) return;
    let active = true;
    void apiRequest<Release>(`/releases/${encodeURIComponent(releaseId)}`)
      .then(({ data }) => {
        if (active)
          setResult({
            id: releaseId,
            release: { ...data, agentName: data.config.name || data.agentId },
          });
      })
      .catch((failure) => {
        if (active)
          setResult({
            id: releaseId,
            error:
              failure instanceof Error ? failure.message : 'The bound release could not be loaded.',
          });
      });
    return () => {
      active = false;
    };
  }, [releaseId, listed]);
  return !listed && result?.id === releaseId ? result : undefined;
}
