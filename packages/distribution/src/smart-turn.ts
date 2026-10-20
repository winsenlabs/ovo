import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { modelTurnDetectorPlugin, type ModelDetectorDefaults } from '@winsendotai/ovo-plugin-turns';
import type { Environment } from './profiles/types.ts';

/** The manifest id agents select (`voice.turnDetector.plugin`). */
export const SMART_TURN_DETECTOR_ID = '@winsendotai/ovo-turn-detector-smart-turn';

/**
 * What an agent that selects Smart Turn gets for the settings it leaves out (docs/eval/turn-bakeoff.md):
 * `shadow` (the rules decide, the model is only compared), a reading again every 300 ms as the
 * silence grows, and the 0.3 threshold (the speed end of the bake-off's trade).
 */
export const SMART_TURN_DEFAULTS: ModelDetectorDefaults = Object.freeze({
  mode: 'shadow',
  recheckMs: 300,
  threshold: 0.3,
});

/**
 * Pipecat Smart Turn v3.2 behind the model gate, over the rules with their trailing-word holds off
 * (in `active` mode). The model file is read from `OVO_TURN_MODELS_DIR/smart-turn/` (the image build
 * fetches it, pinned and SHA-256 checked); the readings run on a worker thread of their own, loaded
 * from `OVO_TURN_WORKER_FILE` when the host is a bundle (the image sets it to the bundled
 * `smart-turn-worker.mjs`), else from the package's source. No model file, a failed load or a failed
 * reading never fails a call: the agent gets the rules (see modelTurnDetectorPlugin).
 */
export async function smartTurnModule(env: Environment = {}) {
  const { SMART_TURN, SmartTurnModel } =
    await import('@winsendotai/ovo-plugin-turn-detector-smart-turn');
  return {
    plugins: [
      modelTurnDetectorPlugin(
        { id: SMART_TURN_DETECTOR_ID, provider: 'pipecat' },
        async () => {
          const directory = env.OVO_TURN_MODELS_DIR?.trim();
          if (!directory) throw new Error('OVO_TURN_MODELS_DIR is not set');
          const modelPath = join(directory, 'smart-turn', SMART_TURN.file);
          await stat(modelPath).catch(() => {
            throw new Error(`Smart Turn model file is missing: ${modelPath}`);
          });
          const file = env.OVO_TURN_WORKER_FILE?.trim();
          return SmartTurnModel.load({
            modelPath,
            ...(file ? { workerUrl: pathToFileURL(file) } : {}),
          });
        },
        SMART_TURN_DEFAULTS,
      ),
    ],
  };
}
