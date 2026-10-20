'use client';
import { useCallback, useEffect, useState } from 'react';
import { routingApi } from './routing-api';
import type { RoutingAvailability } from '../types/routing';

/**
 * Whether routing is available on this installation. `GET /routing/status` answers while routing
 * is off, so a dark feature is a state (`disabled`), never an error; every routing screen renders
 * its header and then `RoutingUnavailable` for it.
 */
export function useRoutingStatus() {
  const [state, setState] = useState<RoutingAvailability>({ kind: 'loading' });
  const load = useCallback(async () => {
    try {
      const status = await routingApi.status();
      setState(status.enabled ? { kind: 'ready', status } : { kind: 'disabled' });
    } catch (failure) {
      setState({
        kind: 'error',
        message: failure instanceof Error ? failure.message : 'Routing status could not be loaded.',
      });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, reload: load };
}
