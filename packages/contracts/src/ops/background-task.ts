/** Capability `ovo.background-task` (cardinality many). The dispatcher runs every provided task. */
export interface BackgroundTask {
  id: string;
  intervalMs: number;
  jitterMs?: number;
  tick(signal: AbortSignal): Promise<void>;
}
