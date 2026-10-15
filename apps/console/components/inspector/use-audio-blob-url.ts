'use client';
import { useEffect, useState } from 'react';

/**
 * INFRASTRUCTURE FINDING (not a foundation/design-system file — see the report): the `/api/v1`
 * proxy (`lib/gateway.ts`) strips `content-length` from every proxied response (it is bucketed
 * into the same hop-by-hop set used for the outgoing request). A JSON `fetch()` doesn't care, but
 * a native `<audio src>` does — Chromium issues a ranged probe request for the recording WAV,
 * gets back a body with no length framing, and the request never resolves (reproduced directly:
 * a plain `curl`/`fetch` GET through the same proxy path completes in milliseconds, but the exact
 * request an `<audio>` element issues hangs indefinitely). Fetching the whole clip ourselves as a
 * `Blob` and handing the `<audio>`/`<video>` element an in-page object URL sidesteps the proxy's
 * range/length handling entirely, inside our own area rather than editing shared proxy code.
 */
export function useAudioBlobUrl(src?: string): { url?: string; error?: string } {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    setState({});
    if (!src) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    fetch(src, { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error(`Recording request failed (${response.status}).`);
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl });
      })
      .catch((failure) => {
        if (!cancelled)
          setState({
            error: failure instanceof Error ? failure.message : 'Recording unavailable.',
          });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  return state;
}
