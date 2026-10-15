import { parentPort, workerData } from 'node:worker_threads';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { lastWindow, logMel, N_FRAMES, N_MELS } from './features.ts';

/**
 * Smart Turn's worker thread (index.ts). A reading is ~65 ms of CPU on the mini, nearly all of it
 * synchronous (the log-mel features in JS, then ONNX Runtime's run), so on the main thread it would
 * stall the event loop of every call in the worker process: STT events, VAD, barge-in, the audio
 * relay. Here it stalls nothing but this thread. Readings run one at a time, in arrival order.
 * Plain TypeScript a Node worker can load as it is (types only, nothing to compile).
 */
export interface SmartTurnWorkerData {
  modelPath: string;
  threads: number;
}

/** A reading of 16 kHz caller audio (the last 8 s at most), newest sample last. */
export interface SmartTurnRequest {
  id: number;
  pcm: Int16Array;
}

export type SmartTurnReply =
  { id: number; probability: number; ms: number } | { id: number; error: string };

const port = parentPort!;
const { modelPath, threads } = workerData as SmartTurnWorkerData;
// As the reference inference.py: sequential execution, one inter-op thread, all optimisations.
const session = await InferenceSession.create(modelPath, {
  executionMode: 'sequential',
  interOpNumThreads: 1,
  intraOpNumThreads: threads,
  graphOptimizationLevel: 'all',
});
const output = session.outputNames[0]!;

async function read({ id, pcm }: SmartTurnRequest): Promise<SmartTurnReply> {
  const started = performance.now();
  try {
    const features = logMel(lastWindow(pcm));
    const input = new Tensor('float32', features, [1, N_MELS, N_FRAMES]);
    const outputs = await session.run({ input_features: input });
    const probability = Number((outputs[output]!.data as Float32Array)[0]);
    return { id, probability, ms: performance.now() - started };
  } catch (error) {
    return { id, error: error instanceof Error ? error.message : String(error) };
  }
}

let queue = Promise.resolve();
port.on('message', (request: SmartTurnRequest) => {
  queue = queue.then(async () => port.postMessage(await read(request)));
});
port.postMessage('ready');
