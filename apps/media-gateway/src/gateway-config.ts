/** Media gateway limits read from the environment, validated as positive integers. */
function integer(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error('invalid positive integer environment value');
  return parsed;
}

function drainTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  if (env.OVO_MEDIA_DRAIN_TIMEOUT_MS !== undefined)
    return integer(env.OVO_MEDIA_DRAIN_TIMEOUT_MS, 1);
  const deregistrationSeconds = integer(env.OVO_MEDIA_DEREGISTRATION_DELAY_SECONDS, 300);
  return Math.max(100, deregistrationSeconds * 1_000 - 30_000);
}

/**
 * The media gateway's limits. One handshake deadline covers route resolution and the worker dial,
 * so the pre-accept audio buffer defaults to that deadline (OBS-9): with the old 3 s default a slow
 * route lookup overflowed the buffer and closed the call before the handshake deadline it was
 * still inside. The buffer's own 6 s byte ceiling still applies.
 */
export function gatewayMediaConfig(env: Readonly<Record<string, string | undefined>>) {
  const handshakeTimeoutMs = integer(env.OVO_MEDIA_HANDSHAKE_TIMEOUT_MS, 5_000);
  return {
    host: env.OVO_MEDIA_HOST ?? '0.0.0.0',
    port: integer(env.OVO_MEDIA_PORT, 8080),
    maxMessageBytes: integer(env.OVO_MEDIA_MAX_MESSAGE_BYTES, 65_536),
    maxAudioFrameBytes: integer(env.OVO_MEDIA_MAX_AUDIO_FRAME_BYTES, 8_192),
    maxBufferedBytes: integer(env.OVO_MEDIA_MAX_BUFFERED_BYTES, 262_144),
    preAcceptBufferMs:
      env.OVO_MEDIA_PRE_ACCEPT_MS !== undefined
        ? integer(env.OVO_MEDIA_PRE_ACCEPT_MS, 3_000)
        : env.OVO_MEDIA_MAX_PENDING_FRAMES === undefined
          ? Math.min(handshakeTimeoutMs, 30_000)
          : undefined,
    maxPendingFrames:
      env.OVO_MEDIA_MAX_PENDING_FRAMES === undefined
        ? undefined
        : integer(env.OVO_MEDIA_MAX_PENDING_FRAMES, 25),
    handshakeTimeoutMs,
    idleTimeoutMs: integer(env.OVO_MEDIA_IDLE_TIMEOUT_MS, 30_000),
    drainTimeoutMs: drainTimeoutMs(env),
  };
}
