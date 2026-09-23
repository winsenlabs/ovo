// Not a violation: *.test.ts files are excluded from the walk, so a test may import anything.
import { a } from '@winsendotai/ovo-plugin-a';

export const inTest = a;
