'use client';
import { useEffect, useRef, useState } from 'react';
export function parseListText(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
export function ListTextInput({
  id,
  value,
  onChange,
  rows = 3,
}: {
  id: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  rows?: number;
}) {
  const [text, setText] = useState(() => value.join('\n'));
  const focused = useRef(false);
  const canonical = value.join('\n');
  useEffect(() => {
    if (!focused.current) setText(canonical);
  }, [canonical]);
  return (
    <textarea
      id={id}
      rows={rows}
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        focused.current = false;
        onChange(parseListText(text));
      }}
    />
  );
}
