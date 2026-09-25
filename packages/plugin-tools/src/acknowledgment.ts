import type { ProcessingSpeech, Speech } from '@winsendotai/ovo-contracts';

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function scheduleProgress(
  processing: ProcessingSpeech,
  speech: Speech,
  signal: AbortSignal,
): Promise<void> {
  const { progress, progressAfterMs, maxProgress } = processing;
  if (!progress?.trim() || maxProgress === 0) return;
  for (let count = 0; count < maxProgress; count += 1) {
    await sleep(progressAfterMs, signal);
    if (signal.aborted) return;
    await speech.speak(progress, { kind: 'progress' });
  }
}

export function startOperationSpeech(processing: ProcessingSpeech, speech: Speech) {
  const progressController = new AbortController();
  void scheduleProgress(processing, speech, progressController.signal).catch(() => undefined);
  const acknowledgment = speech.speak(processing.initial, { kind: 'acknowledgment' });
  void acknowledgment.catch(() => undefined);
  return {
    acknowledgment,
    stopProgress: () => progressController.abort(),
  };
}
