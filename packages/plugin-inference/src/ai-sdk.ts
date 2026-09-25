/**
 * Moved to `@winsendotai/ovo-plugin-kit` (ai-sdk-inference.ts); re-exported for existing callers.
 * `AiSdkInferenceOptions` comes from there too: a second, narrower copy used to live here, and a
 * caller that picked the wrong one silently lost `provider`, `usage`, `sessionId` and `now`.
 */
export {
  AiSdkInference,
  InferenceProtocolError,
  type AiSdkInferenceOptions,
} from '@winsendotai/ovo-plugin-kit/ai-sdk-inference';
