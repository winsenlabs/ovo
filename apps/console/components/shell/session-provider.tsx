'use client';
import { createContext, useContext, type ReactNode } from 'react';
import type { SessionIdentity } from '../../lib/api';

const SessionContext = createContext<SessionIdentity | null>(null);
export function SessionProvider({ identity, children }: { identity: SessionIdentity; children: ReactNode }) {
  return <SessionContext.Provider value={identity}>{children}</SessionContext.Provider>;
}
export function useSession(): SessionIdentity {
  const identity = useContext(SessionContext);
  if (!identity) throw new Error('Console session unavailable');
  return identity;
}
