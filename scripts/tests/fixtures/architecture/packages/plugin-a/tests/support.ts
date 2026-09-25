// Known violation: the kind table applies to tests/ helpers, so this import is reported too
// (it merges into the packages/plugin-a -> packages/plugin-b edge that src/index.ts already makes).
import { b } from '@winsendotai/ovo-plugin-b';

export const fromTests = b;
