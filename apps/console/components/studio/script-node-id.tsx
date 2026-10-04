'use client';
import { useEffect, useRef, useState } from 'react';

export function ScriptNodeId({
  index,
  id,
  onCommit,
}: {
  index: number;
  id: string;
  onCommit: (index: number, id: string) => string | undefined;
}) {
  const [draft, setDraft] = useState(id);
  const [error, setError] = useState<string>();
  const draftRef = useRef(id);
  useEffect(() => {
    draftRef.current = id;
    setDraft(id);
  }, [id]);
  const commit = () => {
    if (draftRef.current === id) return;
    const failure = onCommit(index, draftRef.current);
    setError(failure);
    if (failure) {
      draftRef.current = id;
      setDraft(id);
    }
  };
  return (
    <>
      <label className="sr-only" htmlFor={`node-id-${index}`}>
        Node {index + 1} ID
      </label>
      <input
        id={`node-id-${index}`}
        value={draft}
        onChange={(event) => {
          draftRef.current = event.target.value;
          setDraft(event.target.value);
          setError(undefined);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            draftRef.current = id;
            setDraft(id);
            setError(undefined);
            event.currentTarget.blur();
          }
        }}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `node-id-error-${index}` : undefined}
      />
      {error && (
        <span className="field-error" id={`node-id-error-${index}`} role="alert">
          {error}
        </span>
      )}
    </>
  );
}
