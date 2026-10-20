'use client';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../../lib/api';

/** The time zone the router agent's release runs in (the zone `time` rules read), else IST. */
export function useRouterZone(agentId: string | undefined): string {
  const [zone, setZone] = useState('Asia/Kolkata');
  useEffect(() => {
    if (!agentId) return;
    let live = true;
    void apiRequest<{ config?: { timezone?: string } }>(
      `/agents/${encodeURIComponent(agentId)}`,
    ).then(
      ({ data }) => live && data.config?.timezone && setZone(data.config.timezone),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [agentId]);
  return zone;
}
