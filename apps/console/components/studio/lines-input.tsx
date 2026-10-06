'use client';

/** One entry per line. Unlike the list input, a comma stays inside a spoken line. */
export function parseLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Uncontrolled while typing; committed on blur, and reset whenever the saved value changes. */
export function LinesInput({
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
  const saved = value.join('\n');
  return (
    <textarea
      id={id}
      key={saved}
      rows={rows}
      defaultValue={saved}
      onBlur={(event) => {
        const next = parseLines(event.target.value);
        if (next.join('\n') !== saved) onChange(next);
      }}
    />
  );
}
