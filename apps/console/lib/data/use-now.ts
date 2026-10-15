'use client';
import { useEffect, useState } from 'react';

/** The current time, re-read every `intervalMs`: the clock that makes wait times tick. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
