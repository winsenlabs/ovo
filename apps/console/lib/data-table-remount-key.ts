/**
 * FOUNDATION BUG WORKAROUND (not a design-system edit — see the report): `DataTableV2`
 * (`components/ui/data-table-v2.tsx`) calls `useState` for sort, then returns early for
 * `error`/`loading`/`!rows.length` *before* reaching its `useRef`/`useEffect` for the
 * select-all checkbox. The very first loading→ready (or empty→ready) transition therefore
 * calls a different number of hooks on the *same* component instance — React throws "Rendered
 * more hooks than during the previous render" and the whole page crashes (reproduced on `/calls`
 * on first load). Passing this as the table's `key` forces React to unmount and remount the
 * component across a loading/error/empty/ready class change instead of re-rendering it in
 * place, which sidesteps the mismatch without touching the shared file.
 */
export function dataTableRenderKey(
  loading: boolean,
  error: string | undefined,
  rowCount: number,
): string {
  if (loading) return 'loading';
  if (error) return 'error';
  return rowCount > 0 ? 'ready' : 'empty';
}
