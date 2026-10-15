export interface ImportTarget {
  type: string;
  dir?: string;
  name?: string;
  subpath?: string;
}
export function violation(
  from: { kind: string; dir: string },
  target: ImportTarget,
  kindOf: (dir: string) => string | undefined,
): string | undefined;
