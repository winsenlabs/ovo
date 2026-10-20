/** Move an item of a list one place (`delta` -1 up, +1 down); out of range leaves the list as it was. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Drop an item, but never below `keepAtLeast` items. */
export function removeItem<T>(list: readonly T[], index: number, keepAtLeast = 0): T[] {
  return list.length <= keepAtLeast ? [...list] : list.filter((_, i) => i !== index);
}
