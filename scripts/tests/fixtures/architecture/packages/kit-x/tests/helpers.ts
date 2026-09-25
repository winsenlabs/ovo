// Known violation reachable only from tests/: a kit helper importing a plugin package.
import { a } from '@winsendotai/ovo-plugin-a';

export const helper = a;
