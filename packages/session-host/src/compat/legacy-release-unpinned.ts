import type { CompatRule } from './types.ts';
import { issue } from './types.ts';
export const legacyReleaseUnpinned: CompatRule = (input, stage) =>
  input.selections && Object.keys(input.selections).length
    ? []
    : [
        issue(
          'legacy_release_unpinned',
          stage,
          'Release has no pinned plugin selections',
          {},
          'warning',
        ),
      ];
