// Fetches LiveKit's text turn-detector files (livekit/turn-detector, revision v0.4.1-intl) into the
// Hugging Face caches the official runner reads with `local_files_only` (the audio detector,
// turn-detector-v1-mini, ships inside @livekit/local-inference and needs no fetch).
// LiveKit Model License: these files may be used only together with the LiveKit Agents framework.
// Only the deprecated text model is fetched here, for the Wave 13 bake-off.
import { downloadFileToCacheDir } from '@livekit/agents-plugin-livekit';
import { AutoTokenizer } from '@huggingface/transformers';
import { initializeLogger } from '@livekit/agents';

initializeLogger({ pretty: false, level: 'warn' });

const REPO = 'livekit/turn-detector';
const REVISION = 'v0.4.1-intl';
for (const path of ['onnx/model_q8.onnx', 'languages.json'])
  console.log(await downloadFileToCacheDir({ repo: REPO, path, revision: REVISION }));
await AutoTokenizer.from_pretrained(REPO, { revision: REVISION });
console.log('tokenizer cached');
