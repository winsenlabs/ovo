/** Resolve the last published release across every page before a default fixture call. */
export async function latestFixtureRelease<T>(
  list: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T | undefined> {
  let cursor: string | undefined;
  let latest: T | undefined;
  do {
    const page = await list(cursor);
    latest = page.items.at(-1) ?? latest;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return latest;
}
