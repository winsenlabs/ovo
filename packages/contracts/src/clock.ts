/** Host-injected time. Tests pass a manual clock; plugins never read wall time directly. */
export interface Clock {
  now(): number;
  /** Schedules `fn` after `ms`; the returned function cancels it. */
  setTimeout(fn: () => void, ms: number): () => void;
}
