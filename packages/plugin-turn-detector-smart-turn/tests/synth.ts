/**
 * The reference signal of tests/features.test.ts and model.test.ts: 3 s at 16 kHz of two tones (the
 * second frequency-modulated), gated 3 s on / 1 s off. The reference values were computed from it
 * with transformers 5.x WhisperFeatureExtractor(chunk_length=8) and onnxruntime 1.31 (Python; onnxruntime-node 1.30 agrees) running
 * smart-turn-v3.2-cpu.onnx, as Pipecat's inference.py does (2026-10-14).
 */
export function synth(): Int16Array {
  const out = new Int16Array(3 * 16_000);
  for (let n = 0; n < out.length; n++) {
    if (n % 4000 >= 3000) continue;
    const s =
      8000 * Math.sin((2 * Math.PI * 440 * n) / 16_000) +
      3000 *
        Math.sin(
          (2 * Math.PI * 1234.5 * n) / 16_000 + 0.3 * Math.sin((2 * Math.PI * 3 * n) / 16_000),
        );
    out[n] = Math.round(s);
  }
  return out;
}

export const REFERENCE = {
  probability: 0.256649911403656,
  mean: -0.09079873561859131,
  points: [
    [0, 0, 0.31651628017425537],
    [10, 700, 1.6192715167999268],
    [20, 500, 0.8822726011276245],
    [40, 780, -0.21257591247558594],
    [79, 799, -0.21257591247558594],
    [5, 650, 1.2417829036712646],
    [30, 640, 1.362636685371399],
  ],
} as const;
