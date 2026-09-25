'use client';
import { useRef } from 'react';
export function useOperationId() {
  const id = useRef<string | null>(null);
  return {
    current: () => (id.current ??= crypto.randomUUID()),
    succeeded: () => {
      id.current = null;
    },
  };
}
