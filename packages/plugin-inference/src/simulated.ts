import type { Inference, InferenceReply, InferenceRequest } from '@winsendotai/ovo-contracts';
import type { SimulatedInferenceOptions } from './types.ts';

/** Explicit local fixture provider. It never contacts or impersonates a model API. */
export class SimulatedInference implements Inference {
  readonly requests: InferenceRequest[] = [];

  constructor(private readonly options: SimulatedInferenceOptions = {}) {}

  async generate(request: InferenceRequest): Promise<InferenceReply> {
    const callIndex = this.requests.length;
    this.requests.push(request);
    await abortableDelay(this.options.delayMs ?? 0, request.signal);
    request.signal.throwIfAborted();
    if (this.options.responder) return this.options.responder(request, callIndex);
    const scripted = this.options.replies?.[callIndex];
    return scripted ?? { kind: 'text', text: request.uncertainty, usage: { simulatedRequests: 1 } };
  }
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (durationMs === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, durationMs);
    timer.unref?.();
    signal.addEventListener('abort', aborted, { once: true });

    function done() {
      signal.removeEventListener('abort', aborted);
      resolve();
    }

    function aborted() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    }
  });
}
