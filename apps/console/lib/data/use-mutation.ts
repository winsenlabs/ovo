'use client';
import { useCallback, useState } from 'react';
import { cacheInvalidate } from './cache';
export function useMutation<Input, Output>(mutate: (input: Input) => Promise<Output>, invalidates: readonly string[] = []) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(async (input: Input) => {
    setPending(true); setError(undefined);
    try { const result = await mutate(input); for (const key of invalidates) cacheInvalidate(key); return result; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Operation failed'); throw failure; }
    finally { setPending(false); }
  }, [mutate, invalidates]);
  return { run, pending, error };
}
