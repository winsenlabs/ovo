'use client';
import { useRef } from 'react';

let sequence = 0;
function nextKey() { sequence += 1; return `row-${sequence}`; }
export function useRowKeys(length: number) {
  const keys = useRef<string[]>([]);
  while (keys.current.length < length) keys.current.push(nextKey());
  if (keys.current.length > length) keys.current.length = length;
  return {
    keyAt: (index: number) => keys.current[index] ?? nextKey(),
    insert: (index: number) => { keys.current.splice(index, 0, nextKey()); },
    remove: (index: number) => { keys.current.splice(index, 1); },
    reset: () => { keys.current = []; },
  };
}
