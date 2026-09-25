'use client';
import { useEffect, useRef, useState } from 'react';
import { canonicalJson } from '@winsendotai/ovo-contracts';

export function JsonEditor({ id, value, onValid, objectOnly = true }: {
  id: string; value: unknown; onValid: (value: unknown) => void; objectOnly?: boolean;
}) {
  const canonical = canonicalJson(value);
  const previous = useRef(canonical);
  const focused = useRef(false);
  const dirty = useRef(false);
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (previous.current === canonical) return;
    previous.current = canonical;
    if (!dirty.current && !focused.current) setText(JSON.stringify(value, null, 2));
  }, [canonical, value]);
  return <><textarea id={id} className="code-input compact-code" value={text} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
    onFocus={() => { focused.current = true; }}
    onChange={event => { dirty.current = true; setText(event.target.value); }}
    onBlur={() => {
      focused.current = false;
      try {
        const parsed: unknown = JSON.parse(text);
        if (objectOnly && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Expected object');
        onValid(parsed); dirty.current = false; setError(undefined);
      } catch { setError(objectOnly ? 'Enter a valid JSON object.' : 'Enter valid JSON.'); }
    }} />
    {error && <small className="field-error" id={`${id}-error`}>{error}</small>}
  </>;
}
