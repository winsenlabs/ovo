import type { HandoffFallback, HandoffTarget } from './types.ts';

export function validateTarget(target: HandoffTarget): void {
  if (!target.value.trim() || !['phone', 'queue'].includes(target.kind))
    throw new Error('Invalid handoff target');
}

export function validateFallback(fallback: HandoffFallback): void {
  if (!fallback.message.trim() || !['resume', 'human', 'end'].includes(fallback.kind))
    throw new Error('Invalid handoff fallback');
  if (fallback.kind === 'human' && !fallback.target.trim())
    throw new Error('Human fallback target is required');
}
