'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Plays a short line rendered with a TTS binding (`POST /provider-bindings/:id/preview`), in the
 * 8 kHz band a caller hears. Every preview is a billed provider request, so it runs only on click.
 */
export function VoicePreviewButton({
  bindingId,
  disabled,
}: {
  bindingId: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'rendering' | 'playing'>('idle');
  const [error, setError] = useState<string>();
  const playing = useRef<{ audio: HTMLAudioElement; url: string }>(undefined);
  const stop = () => {
    const current = playing.current;
    playing.current = undefined;
    if (!current) return;
    current.audio.pause();
    URL.revokeObjectURL(current.url);
  };
  useEffect(() => stop, []);

  async function preview() {
    stop();
    setError(undefined);
    setState('rendering');
    try {
      const response = await fetch(
        `/api/v1/provider-bindings/${encodeURIComponent(bindingId)}/preview`,
        {
          method: 'POST',
          headers: { accept: 'audio/wav', 'content-type': 'application/json' },
          body: '{}',
          credentials: 'same-origin',
          cache: 'no-store',
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          { error?: { message?: string } } | undefined;
        throw new Error(payload?.error?.message ?? `Preview failed (${response.status}).`);
      }
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      playing.current = { audio, url };
      audio.onended = () => {
        stop();
        setState('idle');
      };
      setState('playing');
      await audio.play();
    } catch (failure) {
      stop();
      setState('idle');
      setError(failure instanceof Error ? failure.message : 'Preview failed.');
    }
  }

  return (
    <>
      <button
        className="button small"
        type="button"
        disabled={disabled || state === 'rendering'}
        aria-live="polite"
        onClick={() => void preview()}
      >
        {state === 'rendering' ? 'Rendering…' : state === 'playing' ? 'Playing…' : 'Preview voice'}
      </button>
      {error && (
        <small className="field-error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}
