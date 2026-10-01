/** Meter keys retained only for releases that predate explicit voice selections. */
export const LIVE_COST_METER_KEYS = Object.freeze({
  carrier: 'twilio.carrier.audio_seconds',
  tts: 'openai.streaming-tts.characters',
  stt: 'deepgram.streaming-stt.audio_seconds',
  inference: Object.freeze({
    aggregateInput: 'openai.inference.input_tokens',
    uncachedInput: 'openai.inference.uncached_input_tokens',
    cacheReadInput: 'openai.inference.cache_read_input_tokens',
    cacheWriteInput: 'openai.inference.cache_write_input_tokens',
    output: 'openai.inference.output_tokens',
  }),
});
