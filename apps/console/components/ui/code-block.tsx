'use client';
import { useMemo, useState } from 'react';
import { CopyButton } from './section-card';

function byteSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Raw text in a scrollable, collapsed-by-default block. Never the primary view for a value.
 * `code` may be a thunk so large payloads (call evidence) are only serialised once expanded.
 */
export function CodeBlock({
  code,
  language = 'json',
  collapsedLabel,
  filename,
}: {
  code: string | (() => string);
  language?: string;
  collapsedLabel?: string;
  /** Download filename; defaults to `raw.<language>` rather than a hard-coded `evidence.json`
   * for every call site that is not, in fact, evidence. */
  filename?: string;
}) {
  const [open, setOpen] = useState(false);
  // A plain string is already in memory — sizing it costs nothing, so the collapsed label can
  // show "Show raw JSON · 2.1 KB" up front. A thunk (large call evidence) stays lazy: it is only
  // invoked, and only then sized, once the caller actually opens the block.
  const eagerSize = typeof code === 'string' ? byteSize(code) : null;
  const text = useMemo(
    () => (open ? (typeof code === 'function' ? code() : code) : ''),
    [open, code],
  );
  const size = eagerSize ?? (open ? byteSize(text) : null);
  return (
    <div className="ds-code-block">
      <button
        type="button"
        className="ds-code-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open
          ? 'Hide raw'
          : `${collapsedLabel ?? `Show raw ${language.toUpperCase()}`}${size ? ` · ${size}` : ''}`}
      </button>
      {open && (
        <div className="ds-code-body">
          <div className="ds-code-actions">
            <span className="ds-code-size muted">{size}</span>
            <CopyButton value={text} label="Copy code" />
            <a
              className="ds-code-download"
              download={filename ?? `raw.${language}`}
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
            >
              Download
            </a>
          </div>
          <pre className="mono ds-code-pre" tabIndex={0}>
            <code>{text}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

export function JsonViewer({
  value,
  label,
  filename,
}: {
  value: unknown;
  label?: string;
  filename?: string;
}) {
  return (
    <CodeBlock
      code={() => JSON.stringify(value, null, 2)}
      collapsedLabel={label}
      filename={filename}
    />
  );
}
