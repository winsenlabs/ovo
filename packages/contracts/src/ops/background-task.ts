/** Capability `ovo.background-task` (cardinality many, keyed by plugin ID). The dispatcher runs every provided task. */
export interface BackgroundTask {
  id: string;
  intervalMs: number;
  jitterMs?: number;
  tick(signal: AbortSignal): Promise<void>;
}
