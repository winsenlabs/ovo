// A text input backed by a `<datalist>` of suggestions: pick a common value from the list, or
// type anything else (brief §3 New agent: "language Select (BCP-47 list + free entry)"). A plain
// `Select` cannot hold a value outside its option list, which is why this is its own primitive
// rather than a `Select` variant.
export type ComboOption = { value: string; label: string };

export function ComboInput({
  id,
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly ComboOption[];
  placeholder?: string;
  ariaLabel?: string;
}) {
  const listId = `${id}-options`;
  return (
    <>
      <input
        id={id}
        list={listId}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </datalist>
    </>
  );
}
